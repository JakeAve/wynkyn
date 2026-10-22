// server/epub-export.ts — the e-book export (spec §7.8). The same render as
// print, split into one XHTML file per top-level block (a matter block, a
// chapter, a part with its chapters) and zipped as EPUB 3. Reflowable: no
// folios, running heads or sheets — the reader lays the pages out.
import { strToU8, zipSync } from "fflate";
import { parse } from "../parser/parser.ts";
import type { BmlDocument } from "../parser/types.ts";
import { loadMetadata } from "../metadata/loader.ts";
import { escapeHtml, type TocRow, tocRows } from "../renderer/render.ts";
import { buildBook, resolveImages } from "./pipeline.ts";
import { editionToken, metadataPath } from "./editions.ts";

export interface EpubOptions {
  edition?: string | null; // null/undefined = the unnamed edition
  out?: string; // directory; default books/<book>/export[/<edition>]
}

export interface EpubSummary {
  file: string; // the .epub written
  documents: number; // content documents in reading order
  diagnostics: number;
}

/** Everything the package is built from; exportEpub gathers it from disk. */
export interface EpubInput {
  html: string; // render() output: <article class="bml">…</article>
  css: string;
  title: string;
  author?: string;
  language: string;
  identifier: string;
  modified: string; // ISO 8601, whole seconds
  rows: TocRow[];
  images: Record<string, Uint8Array>; // images/<name> → bytes
  cover?: string; // images/<name>
}

const XHTML = "application/xhtml+xml";
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  css: "text/css",
};
const VOID = new Set([
  "br",
  "img",
  "hr",
  "wbr",
  "col",
  "input",
  "link",
  "meta",
]);

// Reader defaults the print CSS never needed: a plain nav list, a cover page.
const EPUB_CSS = `
.toc ol { list-style: none; padding-left: 1.5em; margin: 0; }
.toc > ol { padding-left: 0; }
.toc li { margin: 0.3em 0; }
.cover { text-align: center; }
.cover img { max-width: 100%; max-height: 100%; }
`;

/** The article's top-level children, each as one HTML string. A block's
 * endnotes (`aside.notes`, a top-level sibling in render()) stay with it. */
export function splitBlocks(html: string): string[] {
  const body = html.slice(
    html.indexOf(">") + 1,
    html.lastIndexOf("</article>"),
  );
  const chunks: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    const [whole, close, name, selfClose] = m;
    if (VOID.has(name!.toLowerCase()) || selfClose) continue;
    depth += close ? -1 : 1;
    if (depth === 0) {
      const end = m.index! + whole.length;
      const chunk = body.slice(start, end);
      start = end;
      if (chunk.startsWith('<aside class="notes') && chunks.length) {
        chunks[chunks.length - 1] += chunk;
      } else chunks.push(chunk);
    }
  }
  return chunks;
}

/** HTML5 serialization → well-formed XHTML, with EPUB 3 popup notes. */
export function toXhtml(html: string): string {
  return html
    .replace(/<(br|img|hr|wbr)\b([^>]*?)\s*\/?>/g, "<$1$2/>")
    .replace(
      /(<sup class="footnote-anchor" id="[^"]*"><a )href="/g,
      '$1epub:type="noteref" href="',
    )
    .replace(
      /<div class="note" id="/g,
      '<div epub:type="footnote" class="note" id="',
    );
}

function document(
  body: string,
  title: string,
  language: string,
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${
    escapeHtml(language)
  }" xml:lang="${escapeHtml(language)}">
<head><meta charset="utf-8"/><title>${
    escapeHtml(title)
  }</title><link rel="stylesheet" href="book.css"/></head>
<body>${body}</body>
</html>
`;
}

const level = (r: TocRow) =>
  r.cls.startsWith("toc-heading")
    ? (r.cls.includes("in-part") ? 2 : 1)
    : r.cls.includes("in-part")
    ? 1
    : 0;

/** The nav document's list: parts hold their chapters, chapters their headings. */
export function navList(
  rows: TocRow[],
  hrefOf: (id: string) => string,
): string {
  let out = "<ol>";
  let depth = 0;
  let liOpen = false;
  for (const r of rows) {
    let l = level(r);
    if (l > depth && !liOpen) l = depth; // nothing to nest under
    while (l > depth) {
      out += "<ol>";
      depth++;
      liOpen = false;
    }
    while (l < depth) {
      if (liOpen) out += "</li>";
      out += "</ol></li>"; // the parent item closes with its list
      depth--;
      liOpen = false;
    }
    if (liOpen) out += "</li>";
    const text = [r.number, r.label].filter(Boolean).join(" ") || r.href;
    out += `<li><a href="${escapeHtml(hrefOf(r.href))}">${
      escapeHtml(text)
    }</a>`;
    liOpen = true;
  }
  if (liOpen) out += "</li>";
  while (depth-- > 0) out += "</ol></li>";
  return out + "</ol>";
}

function fileName(i: number, block: string): string {
  const id = /\sid="([^"]*)"/.exec(block)?.[1] ?? "block";
  return `${String(i + 1).padStart(3, "0")}-${
    id.replace(/[^A-Za-z0-9_-]+/g, "-")
  }.xhtml`;
}

/** The whole package as zip entries, in EPUB order (mimetype first, stored). */
export function buildEpub(input: EpubInput): Uint8Array {
  const blocks = splitBlocks(input.html);
  const names = blocks.map((b, i) =>
    /^<section class="matter matter-toc\b/.test(b)
      ? "nav.xhtml"
      : fileName(i, b)
  );
  // Where every id lives, so links can cross files.
  const fileOf = new Map<string, string>();
  blocks.forEach((b, i) => {
    for (const m of b.matchAll(/\sid="([^"]*)"/g)) fileOf.set(m[1]!, names[i]!);
  });
  const hrefOf = (id: string) => `${fileOf.get(id) ?? ""}#${id}`;
  const labelOf = new Map(input.rows.map((r) => [r.href, r.label || r.number]));
  const nav = `<nav epub:type="toc" class="toc" id="toc">`;
  const list = navList(input.rows, hrefOf);

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
    ),
  };
  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="${XHTML}" properties="nav"/>`,
    `<item id="css" href="book.css" media-type="text/css"/>`,
  ];
  const spine: string[] = [];
  let hasNav = false;
  blocks.forEach((block, i) => {
    const name = names[i]!;
    let body = block
      .replace(
        /href="#([^"]*)"/g,
        (_, id) => `href="${escapeHtml(hrefOf(id))}"`,
      )
      // {ref} targets have no page here: name the target instead (the TOC
      // label, else the slug). Edition spans (§3.2.9) can word around it.
      .replace(
        /(<a class="ref" href="[^"]*">)(<\/a>)/g,
        (_, open: string, close: string) => {
          const id = /#([^"]*)"/.exec(open)?.[1] ?? "";
          return `${open}${escapeHtml(labelOf.get(id) || id)}${close}`;
        },
      );
    if (name === "nav.xhtml") {
      hasNav = true;
      body = body.replace(
        /<nav class="toc">[\s\S]*<\/nav>/,
        `${nav}${list}</nav>`,
      );
    } else {
      const id = `doc${i + 1}`;
      manifest.push(`<item id="${id}" href="${name}" media-type="${XHTML}"/>`);
      spine.push(`<itemref idref="${id}"/>`);
    }
    files[`OEBPS/${name}`] = strToU8(document(
      `<article class="bml">${toXhtml(body)}</article>`,
      input.title,
      input.language,
    ));
  });
  if (hasNav) {
    spine.splice(names.indexOf("nav.xhtml"), 0, `<itemref idref="nav"/>`);
  } else {
    files["OEBPS/nav.xhtml"] = strToU8(document(
      `<article class="bml">${nav}<h1 class="title">Contents</h1>${list}</nav></article>`,
      input.title,
      input.language,
    ));
  }
  if (input.cover) {
    manifest.push(
      `<item id="cover" href="cover.xhtml" media-type="${XHTML}"/>`,
    );
    spine.unshift(`<itemref idref="cover"/>`);
    files["OEBPS/cover.xhtml"] = strToU8(document(
      `<section class="cover"><img src="${
        escapeHtml(input.cover)
      }" alt=""/></section>`,
      input.title,
      input.language,
    ));
  }
  let n = 0;
  for (const [name, bytes] of Object.entries(input.images)) {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const cover = name === input.cover ? ` properties="cover-image"` : "";
    manifest.push(
      `<item id="img${++n}" href="${escapeHtml(name)}" media-type="${
        MEDIA_TYPES[ext] ?? "application/octet-stream"
      }"${cover}/>`,
    );
    files[`OEBPS/${name}`] = bytes;
  }
  files["OEBPS/book.css"] = strToU8(input.css + EPUB_CSS);
  files["OEBPS/content.opf"] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${
      escapeHtml(input.language)
    }">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${escapeHtml(input.identifier)}</dc:identifier>
<dc:title>${escapeHtml(input.title)}</dc:title>
<dc:language>${escapeHtml(input.language)}</dc:language>
${
      input.author
        ? `<dc:creator>${escapeHtml(input.author)}</dc:creator>\n`
        : ""
    }<meta property="dcterms:modified">${escapeHtml(input.modified)}</meta>
</metadata>
<manifest>
${manifest.join("\n")}
</manifest>
<spine>
${spine.join("\n")}
</spine>
</package>
`,
  );
  return zipSync(files);
}

function frontText(doc: BmlDocument, name: string): string | undefined {
  for (const m of doc.frontMatter) {
    for (const c of m.children) {
      if (c.kind === "component" && c.name === name) {
        return c.inlines.map((i) => (i.kind === "text" ? i.text : "")).join("");
      }
    }
  }
}

/** A urn:uuid that is the same on every export of this book and edition, so a
 * reader's library sees a re-export as the same book. `ebook.identifier`
 * (an ISBN, say) overrides it. */
export async function stableIdentifier(seed: string): Promise<string> {
  const h = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${
    hex.slice(12, 16)
  }-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function exportEpub(
  booksRoot: string,
  book: string,
  opts: EpubOptions = {},
): Promise<EpubSummary> {
  const bookDir = `${booksRoot}/${book}`;
  let source: string;
  try {
    source = await Deno.readTextFile(`${bookDir}/manuscript.md`);
  } catch {
    throw new Error(`no such book: ${book}`);
  }
  const edition = opts.edition ?? null;
  // Notes go to the end of their block: a reader has no page foot to float to.
  const b = await buildBook(booksRoot, book, {
    edition,
    imageUrlPrefix: "images",
    notes: { placement: "endnote" },
  });
  // ponytail: parses the manuscript a second time for the TOC rows and the
  // author; return the tree from buildBook if that ever shows up.
  const doc = parse(source, { edition: editionToken(edition) });
  const m = (await loadMetadata(metadataPath(booksRoot, book, edition))) ?? {};
  const images: Record<string, Uint8Array> = {};
  const resolved = await resolveImages(booksRoot, book, "images");
  const cover = m.ebook?.cover ? resolved[m.ebook.cover] : undefined;
  const used = new Set(
    [...b.html.matchAll(/src="images\/([^"]+)"/g)].map((x) => `images/${x[1]}`),
  );
  if (cover) used.add(cover);
  for (const name of used) {
    images[name] = await Deno.readFile(`${bookDir}/${name}`);
  }
  const epub = buildEpub({
    html: b.html,
    css: b.baseCss + b.domCss,
    title: b.bookTitle,
    author: frontText(doc, "author"),
    language: m.ebook?.language ?? "en",
    identifier: m.ebook?.identifier ??
      await stableIdentifier(`${book}/${edition ?? ""}`),
    modified: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    rows: tocRows(doc, { numbering: m.numbering, toc: m.toc }),
    images,
    cover,
  });
  const out = opts.out ??
    (edition === null ? `${bookDir}/export` : `${bookDir}/export/${edition}`);
  await Deno.mkdir(out, { recursive: true });
  const file = `${out}/book.epub`;
  await Deno.writeFile(file, epub);
  return {
    file,
    documents: splitBlocks(b.html).length + (cover ? 1 : 0),
    diagnostics: b.diagnostics.length,
  };
}
