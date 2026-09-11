// server/pipeline.ts — one build of one book: files on disk → HTML + CSS strings
// (spec §5.4). Replaces the Plan 0 throwaway scripts/preview.ts; Plan 5's print
// export composes the same pipeline.
import { parse } from "../parser/parser.ts";
import { loadMetadata } from "../metadata/loader.ts";
import {
  generateDomCSS,
  generateFontLinks,
  generatePagedCSS,
} from "../metadata/css-generator.ts";
import { render } from "../renderer/render.ts";
import { metadataPath } from "./editions.ts";
import type { BmlDocument, Diagnostic } from "../parser/types.ts";

const BASE_CSS = await Deno.readTextFile(
  new URL("../renderer/base.css", import.meta.url),
);
const PLATES_JS = await Deno.readTextFile(
  new URL("../renderer/plates.js", import.meta.url),
);

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
  fontLinks: string; // <link> tags for Google Fonts
  diagnostics: Diagnostic[];
}

export function toHtml(b: BuildResult): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${b.bookTitle}</title>
${b.fontLinks}
<style>${b.baseCss}\n${b.domCss}\n${b.pagedCss}</style>
<script>window.PagedConfig = { after() { document.documentElement.dataset.paged = "done"; } };</script>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>
<script>${PLATES_JS}</script>
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
  const doc = parse(source);
  const metaPath = metadataPath(booksRoot, book, edition);
  const meta = await loadMetadata(metaPath);
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
    fontLinks: generateFontLinks(m),
    diagnostics: doc.diagnostics,
  };
}
