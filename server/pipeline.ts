// server/pipeline.ts — one build of one book: files on disk → HTML + CSS strings
// (spec §5.4). Replaces the Plan 0 throwaway scripts/preview.ts; Plan 5's print
// export composes the same pipeline.
import { checkOnlySpans, parse } from "../parser/parser.ts";
import { loadMetadataText } from "../metadata/loader.ts";
import {
  generateDomCSS,
  generateFontLinks,
  generatePagedCSS,
  type PageNumberingConfig,
  pageNumberingConfig,
} from "../metadata/css-generator.ts";
import { render } from "../renderer/render.ts";
import {
  editionSlugs,
  editionToken,
  editionTokens,
  metadataPath,
} from "./editions.ts";
import type { BmlDocument, Diagnostic } from "../parser/types.ts";
import type { Seed } from "../renderer/page-map-types.ts";

const BASE_CSS = await Deno.readTextFile(
  new URL("../renderer/base.css", import.meta.url),
);
// Paged.js 0.4.3, vendored (see server/vendor_test.ts). Shared by toHtml and
// the browser tests so nothing loads it from a CDN.
export const PAGED_JS = await Deno.readTextFile(
  new URL("../vendor/pagedjs/paged.js", import.meta.url),
);
const PLATES_JS = await Deno.readTextFile(
  new URL("../renderer/plates.js", import.meta.url),
);
const FOLIOS_JS = await Deno.readTextFile(
  new URL("../renderer/folios.js", import.meta.url),
);

// Export driver (spec §5.4): starting from BOOK_SEED (the last export's settled
// folios, or {}), re-render until the page map's folios are the ones the
// render was seeded with, then leave the outcome on <html> for
// pdf.ts — data-paged=done|error|fatal plus a JSON report in
// data-paged-report. "error" is pagination problems (--force exports anyway);
// "fatal" is the driver itself failing (e.g. Paged.js didn't load), which
// never exports.
// The book's <style> is fed to Paged.js explicitly and removed, so it isn't
// also applied unpolished; Paged.js's removeStyles is never called.
const DRIVER_JS = `document.addEventListener("DOMContentLoaded", async () => {
  const root = document.documentElement;
  const styleEl = document.getElementById("book-css");
  const css = { [location.href]: styleEl.textContent };
  styleEl.remove();
  const html = document.body.innerHTML;
  document.body.innerHTML = "";
  let previewer = null;
  let passes = 0;
  let report;
  try {
    const r = await BookPageMap.settle(async (seed) => {
      previewer?.polisher.destroy();
      document.querySelector(".pagedjs_pages")?.remove();
      passes++;
      previewer = new Paged.Previewer({ pageMap: { seed, numbering: BOOK_NUMBERING } });
      return (await previewer.preview(html, [css], document.body)).pageMapResult;
    }, BOOK_SEED);
    report = {
      problems: r.problems,
      passes: r.passes,
      digest: BookPageMap.digest(r.map),
      seed: r.seed,
    };
  } catch (err) {
    report = { fatal: String(err), passes };
  }
  root.dataset.pagedReport = JSON.stringify(report);
  root.dataset.paged = report.fatal ? "fatal" : report.problems.length ? "error" : "done";
});`;

// spec §4.11 item 8: try these in order for each {illustration:}/{dropcap|image:} slug.
const IMAGE_EXT_ORDER = ["svg", "png", "jpg", "jpeg", "webp"];

export interface BuildOptions {
  imageUrlPrefix?: string; // default /books/<book>/images
  edition?: string | null; // null/undefined = the unnamed edition (metadata.json)
}

export interface BuildResult {
  book: string;
  edition: string | null;
  bookTitle: string;
  html: string; // render() output — body content only, no <html> wrapper
  baseCss: string;
  domCss: string;
  pagedCss: string;
  pageNumbering: PageNumberingConfig; // per-zone folio style, for the page map
  fontLinks: string; // <link> tags for Google Fonts
  diagnostics: Diagnostic[];
  manuscriptVersion: string; // contentVersion of the manuscript text built from
  metadataVersion: string | null; // ... of the metadata file text; null if absent
}

/** What the dev server sends over the WebSocket. */
export type ServerMessage = (BuildResult & { type: "update" }) | {
  type: "error";
  book: string;
  edition: string | null;
  message: string;
  save?: "metadata"; // a debounced metadata write failed (else a build error)
};

/** First 16 hex chars of SHA-256. Server-side only: crypto.subtle is undefined
 * in browsers on plain http over a LAN IP. */
export async function contentVersion(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(hash).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `seed`: the page map's starting folios (default {}); print export passes the last one. */
export function toHtml(b: BuildResult, opts: { seed?: Seed } = {}): string {
  const json = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${b.bookTitle}</title>
${b.fontLinks}
<style id="book-css">${b.baseCss}\n${b.domCss}\n${b.pagedCss}</style>
<script>const BOOK_NUMBERING = ${json(b.pageNumbering)};
const BOOK_SEED = ${json(opts.seed ?? {})};</script>
<script>${PAGED_JS}</script>
<script>${PLATES_JS}</script>
<script>${FOLIOS_JS}</script>
<script>${DRIVER_JS}</script>
</head><body>${b.html}</body></html>`;
}

export async function listBooks(booksRoot: string): Promise<string[]> {
  const books: string[] = [];
  for await (const e of Deno.readDir(booksRoot)) {
    if (!e.isDirectory) continue;
    try {
      await Deno.stat(`${booksRoot}/${e.name}/manuscript.md`);
      books.push(e.name);
    } catch {
      // directory without a manuscript — not a book
    }
  }
  return books.sort();
}

export function extractBookTitle(doc: BmlDocument, fallback: string): string {
  for (const m of doc.frontMatter) {
    for (const c of m.children) {
      if (c.kind === "component" && c.name === "title") {
        return c.inlines.map((i) => (i.kind === "text" ? i.text : "")).join("");
      }
    }
  }
  return fallback;
}

async function resolveImages(
  bookDir: string,
  urlPrefix: string,
): Promise<Record<string, string>> {
  const bySlug = new Map<string, Map<string, string>>(); // slug → ext → filename
  try {
    for await (const f of Deno.readDir(`${bookDir}/images`)) {
      if (!f.isFile) continue;
      const dot = f.name.lastIndexOf(".");
      if (dot <= 0) continue;
      const slug = f.name.slice(0, dot);
      const ext = f.name.slice(dot + 1).toLowerCase();
      let exts = bySlug.get(slug);
      if (!exts) bySlug.set(slug, exts = new Map());
      exts.set(ext, f.name);
    }
  } catch {
    return {}; // no images/ directory — unresolved slugs render placeholders
  }
  const images: Record<string, string> = {};
  for (const [slug, exts] of bySlug) {
    const ext = IMAGE_EXT_ORDER.find((e) => exts.has(e));
    const name = ext ? exts.get(ext)! : [...exts.values()].sort()[0]!;
    images[slug] = `${urlPrefix}/${name}`;
  }
  return images;
}

export async function buildBook(
  booksRoot: string,
  book: string,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const bookDir = `${booksRoot}/${book}`;
  const edition = opts.edition ?? null;
  const imageUrlPrefix = opts.imageUrlPrefix ?? `/books/${book}/images`;
  const source = await Deno.readTextFile(`${bookDir}/manuscript.md`);
  // EXPERIMENTAL {only} (spec §3.2.9): keep this edition's spans, flag tokens
  // no edition of this book answers to.
  const doc = parse(source, { edition: editionToken(edition) });
  const tokens = editionTokens(await editionSlugs(booksRoot, book));
  const metaPath = metadataPath(booksRoot, book, edition);
  const loaded = await loadMetadataText(metaPath);
  const meta = loaded?.meta ?? null;
  if (meta === null && edition !== null) {
    // Missing metadata.json is fine (spec §4); a missing named edition is not.
    throw new Deno.errors.NotFound(`no such edition: ${book}/${edition}`);
  }
  const m = meta ?? {};
  const images = await resolveImages(bookDir, imageUrlPrefix);
  const bookTitle = extractBookTitle(doc, book);
  return {
    book,
    edition,
    bookTitle,
    html: render(doc, {
      numbering: m.numbering,
      notes: m.notes,
      toc: m.toc,
      images,
    }),
    baseCss: BASE_CSS,
    domCss: generateDomCSS(m),
    pagedCss: generatePagedCSS(m, { bookTitle }),
    pageNumbering: pageNumberingConfig(m),
    fontLinks: generateFontLinks(m),
    diagnostics: [
      ...doc.diagnostics,
      ...checkOnlySpans(doc.onlySpans, tokens),
    ],
    manuscriptVersion: await contentVersion(source),
    metadataVersion: loaded ? await contentVersion(loaded.text) : null,
  };
}
