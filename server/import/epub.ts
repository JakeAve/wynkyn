// server/import/epub.ts — an EPUB into blocks (spec §7.9): unzip, read the
// package document for metadata, manifest and spine, the nav document (or
// NCX) for the book's own contents, then every spine item through the HTML
// reader. Images are collected by the `src` the blocks reference.
import { strFromU8, unzipSync } from "fflate";
import { gutenbergNumber, type Source } from "./blocks.ts";
import { readHtml } from "./html.ts";
import { textOf, tokenize } from "./xml.ts";

const dirOf = (p: string) =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
function resolve(base: string, href: string): string {
  const parts = (dirOf(base) + decodeURIComponent(href.split("#")[0]!)).split(
    "/",
  );
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

/** The text inside every `<tag>` of a document, squashed, empties dropped. */
function innerTexts(doc: string, tag: string): string[] {
  const out: string[] = [];
  let depth = 0, buf = "";
  for (const t of tokenize(doc)) {
    if (t.type === "open" && t.name === tag) (depth = 1), (buf = "");
    else if (depth && t.type === "close" && t.name === tag) {
      depth = 0;
      if (buf.trim()) out.push(buf.replace(/\s+/g, " ").trim());
    } else if (depth && t.type === "text") buf += t.text;
  }
  return out;
}

export function readEpub(name: string, bytes: Uint8Array): Source {
  const files = unzipSync(bytes);
  const text = (p: string) => files[p] ? strFromU8(files[p]!) : undefined;
  const container = text("META-INF/container.xml") ?? "";
  const rootfile = tokenize(container).find((t) =>
    t.type === "open" && t.name === "rootfile"
  );
  const opfPath = rootfile?.type === "open"
    ? rootfile.attrs["full-path"]
    : undefined;
  if (!opfPath || !files[opfPath]) {
    throw new Error("not an EPUB: no package document");
  }
  const opf = tokenize(text(opfPath)!);

  const src: Source = {
    name,
    title: textOf(opf, "dc:title"),
    author: textOf(opf, "dc:creator"),
    tocTitles: [],
    blocks: [],
    images: {},
  };
  const date = textOf(opf, "dc:date");
  src.year = date?.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];
  const ident = textOf(opf, "dc:identifier") ?? "";
  src.gutenberg = gutenbergNumber(ident);
  if (src.gutenberg) src.year = undefined; // dc:date is the release date there

  const manifest = new Map<
    string,
    { href: string; type: string; props: string }
  >();
  const spine: string[] = [];
  let ncxId: string | undefined;
  for (const t of opf) {
    if (t.type !== "open") continue;
    if (t.name === "item" && t.attrs.id && t.attrs.href) {
      manifest.set(t.attrs.id, {
        href: resolve(opfPath, t.attrs.href),
        type: t.attrs["media-type"] ?? "",
        props: t.attrs.properties ?? "",
      });
    } else if (t.name === "itemref" && t.attrs.idref) spine.push(t.attrs.idref);
    else if (t.name === "spine" && t.attrs.toc) ncxId = t.attrs.toc;
  }

  // The book's own contents: EPUB 3 nav, else the NCX.
  const nav = [...manifest.values()].find((m) =>
    m.props.split(/\s+/).includes("nav")
  );
  const ncx = ncxId ? manifest.get(ncxId) : undefined;
  if (nav && files[nav.href]) {
    src.tocTitles = innerTexts(text(nav.href)!, "a");
  } else if (ncx && files[ncx.href]) {
    src.tocTitles = innerTexts(text(ncx.href)!, "navlabel");
  }

  for (const id of spine) {
    const item = manifest.get(id);
    if (!item || !/html|xml/.test(item.type) || item.props.includes("nav")) {
      continue;
    }
    const doc = text(item.href);
    if (!doc) continue;
    const { blocks } = readHtml(doc);
    for (const b of blocks) {
      if (b.kind === "image") {
        const path = resolve(item.href, b.src);
        const data = files[path];
        if (!data) continue;
        b.src = path.slice(path.lastIndexOf("/") + 1);
        src.images[b.src] = data;
      }
      src.blocks.push(b);
    }
  }
  return src;
}
