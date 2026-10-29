// server/pipeline.ts — one build of one book: files in a BookStore → HTML + CSS
// strings (spec §5.4). Pure over the store, so it runs in Deno (the server,
// the CLI, print export) and in the browser (the hosted app builds the book
// itself from the author's own folder). Export-only pieces that need Deno —
// the vendored Paged.js, the driver, toHtml — live in export-html.ts.
import { checkOnlySpans, parse } from "../parser/parser.ts";
import { parseMetadataText } from "../metadata/loader.ts";
import {
  type DomRule,
  domRules,
  generateFontLinks,
  generatePagedCSS,
  type PageNumberingConfig,
  pageNumberingConfig,
} from "../metadata/css-generator.ts";
import {
  render,
  type RenderOptions,
  renderSegments,
} from "../renderer/render.ts";
import type { Segment } from "../renderer/page-map-types.ts";
import {
  editionSlugs,
  editionToken,
  editionTokens,
  metadataKey,
} from "./editions.ts";
import { asStore, type BookStore } from "./store.ts";
import { IMAGE_EXTS } from "./images.ts";
import type { BmlDocument, Diagnostic } from "../parser/types.ts";
import type { Metadata, NotesConfig } from "../metadata/types.ts";

export class NotFoundError extends Error {}

export interface BuildOptions {
  imageUrlPrefix?: string; // default /books/<book>/images
  /** Where the page finds an image, by its file name; overrides the prefix
   * (the browser serves its own files as object URLs). */
  imageUrl?: (book: string, name: string) => string | Promise<string>;
  edition?: string | null; // null/undefined = the unnamed edition (metadata.json)
  notes?: NotesConfig; // overrides metadata's note placement (the e-book wants endnotes)
  /** Style the build with this instead of the file's metadata (try it on, spec
   * §4.13): nothing is written, and `metadataVersion` stays the file's. A
   * missing named edition still throws NotFoundError. */
  metadata?: Metadata;
  baseCss?: string; // renderer/base.css; Deno callers may leave it to be read from disk
}

export interface BuildResult {
  book: string;
  edition: string | null;
  bookTitle: string;
  doc: BmlDocument; // the parsed tree the html was rendered from
  html: string; // render() output — body content only, no <html> wrapper
  segments: Segment[]; // the same book cut where pages break (renderSegments)
  imageUrls: Record<string, string>; // image file name → the URL html uses
  baseCss: string;
  domCss: string;
  domRules: DomRule[]; // domCss rule by rule, for the preview cache
  pagedCss: string;
  pageNumbering: PageNumberingConfig; // per-zone folio style, for the page map
  fontLinks: string; // <link> tags for Google Fonts
  diagnostics: Diagnostic[];
  manuscriptVersion: string; // contentVersion of the manuscript text built from
  metadataVersion: string | null; // ... of the metadata file text; null if absent
}

/** What the book service sends to a subscribed editor. */
export type ServerMessage = (BuildResult & { type: "update" }) | {
  type: "error";
  book: string;
  edition: string | null;
  message: string;
};

/** First 16 hex chars of SHA-256. Needs a secure context: crypto.subtle is
 * undefined in browsers on plain http over a LAN IP. */
export async function contentVersion(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(hash).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function listBooks(root: string | BookStore): Promise<string[]> {
  return asStore(root).list();
}

export function extractBookTitle(doc: BmlDocument, fallback: string): string {
  // The title page names the book; a preface set before it does not.
  const ranked = [...doc.frontMatter].sort((a, b) =>
    Number(b.type === "title-page") - Number(a.type === "title-page")
  );
  for (const m of ranked) {
    for (const c of m.children) {
      if (c.kind === "component" && c.name === "title") {
        return c.inlines.map((i) => (i.kind === "text" ? i.text : "")).join("");
      }
    }
  }
  return fallback;
}

/** slug → the file name that serves it, from the book's images/ folder. */
export async function imageFiles(
  store: BookStore,
  book: string,
): Promise<Record<string, string>> {
  const bySlug = new Map<string, Map<string, string>>(); // slug → ext → filename
  for (const name of await store.listDir(`${book}/images`)) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const slug = name.slice(0, dot);
    const ext = name.slice(dot + 1).toLowerCase();
    let exts = bySlug.get(slug);
    if (!exts) bySlug.set(slug, exts = new Map());
    exts.set(ext, name);
  }
  const files: Record<string, string> = {};
  for (const [slug, exts] of bySlug) {
    const ext = IMAGE_EXTS.find((e) => exts.has(e));
    files[slug] = ext ? exts.get(ext)! : [...exts.values()].sort()[0]!;
  }
  return files; // no images/ folder → {}: unresolved slugs render placeholders
}

export async function resolveImages(
  root: string | BookStore,
  book: string,
  urlPrefix: string,
  imageUrl?: BuildOptions["imageUrl"],
): Promise<Record<string, string>> {
  return (await imageUrlMaps(root, book, urlPrefix, imageUrl)).images;
}

// slug → URL for the renderer, and file name → URL for whoever rewrites them.
async function imageUrlMaps(
  root: string | BookStore,
  book: string,
  urlPrefix: string,
  imageUrl?: BuildOptions["imageUrl"],
) {
  const images: Record<string, string> = {};
  const imageUrls: Record<string, string> = {};
  for (
    const [slug, name] of Object.entries(await imageFiles(asStore(root), book))
  ) {
    images[slug] = imageUrls[name] = imageUrl
      ? await imageUrl(book, name)
      : `${urlPrefix}/${encodeURIComponent(name)}`;
  }
  return { images, imageUrls };
}

// Deno callers (CLI, exports, tests) don't carry base.css around; read it once.
// ponytail: a Deno.* reference inside a function is fine for the browser
// bundle, which only ever passes `baseCss`.
let baseCssOnDisk: Promise<string> | undefined;
const defaultBaseCss = () =>
  baseCssOnDisk ??= Deno.readTextFile(
    new URL("../renderer/base.css", import.meta.url),
  );

export async function buildBook(
  root: string | BookStore,
  book: string,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const store = asStore(root);
  const edition = opts.edition ?? null;
  const imageUrlPrefix = opts.imageUrlPrefix ?? `/books/${book}/images`;
  const source = await store.readText(`${book}/manuscript.md`);
  if (source === null) throw new NotFoundError(`no such book: ${book}`);
  // EXPERIMENTAL {only} (spec §3.2.9): keep this edition's spans, flag tokens
  // no edition of this book answers to.
  const doc = parse(source, { edition: editionToken(edition) });
  const tokens = editionTokens(await editionSlugs(store, book));
  const metaPath = metadataKey(book, edition);
  const text = await store.readText(metaPath);
  const loaded = text === null ? null : parseMetadataText(text, metaPath);
  if (loaded === null && edition !== null) {
    // Missing metadata.json is fine (spec §4); a missing named edition is not.
    throw new NotFoundError(`no such edition: ${book}/${edition}`);
  }
  const m = opts.metadata ?? loaded?.meta ?? {};
  const { images, imageUrls } = await imageUrlMaps(
    store,
    book,
    imageUrlPrefix,
    opts.imageUrl,
  );
  const bookTitle = extractBookTitle(doc, book);
  const rules = domRules(m);
  const renderOpts: RenderOptions = {
    numbering: m.numbering,
    notes: opts.notes ?? m.notes,
    toc: m.toc,
    images,
    language: m.language ?? m.ebook?.language,
    bookTitle: m.openers?.["book-title"] ? bookTitle : undefined,
    elements: m.elements,
    is: m.is,
    onePage: m["one-page"],
  };
  return {
    book,
    edition,
    bookTitle,
    doc,
    html: render(doc, renderOpts),
    segments: renderSegments(doc, renderOpts),
    imageUrls,
    baseCss: opts.baseCss ?? await defaultBaseCss(),
    domCss: rules.map((r) => r.css).join(""),
    domRules: rules,
    pagedCss: generatePagedCSS(m),
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
