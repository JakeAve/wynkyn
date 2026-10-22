// server/import/epub.ts — an EPUB into blocks (spec §7.9): unzip, read the
// package document for metadata, manifest and spine, the nav document (or
// NCX) for the book's own contents, then every spine item through the HTML
// reader. Images are collected by the `src` the blocks reference.
import { strFromU8, unzipSync } from "fflate";
import type { Source } from "./blocks.ts";
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
    language: textOf(opf, "dc:language"),
    tocTitles: [],
    blocks: [],
    images: {},
  };
  const date = textOf(opf, "dc:date");
  src.year = date?.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];
  const ident = textOf(opf, "dc:identifier") ?? "";
  src.gutenberg = ident.match(/gutenberg\.org\/(?:ebooks\/|etext\/)?(\d+)/)
    ?.[1];
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
  if (nav && files[nav.href]) {
    let inA = false, buf = "";
    for (const t of tokenize(text(nav.href)!)) {
      if (t.type === "open" && t.name === "a") (inA = true), (buf = "");
      else if (t.type === "close" && t.name === "a") {
        inA = false;
        if (buf.trim()) src.tocTitles.push(buf.replace(/\s+/g, " ").trim());
      } else if (inA && t.type === "text") buf += t.text;
    }
  } else if (ncxId && manifest.get(ncxId) && files[manifest.get(ncxId)!.href]) {
    let inLabel = false, buf = "";
    for (const t of tokenize(text(manifest.get(ncxId)!.href)!)) {
      if (t.type === "open" && t.name === "navlabel") {
        (inLabel = true), (buf = "");
      } else if (t.type === "close" && t.name === "navlabel") {
        inLabel = false;
        if (buf.trim()) src.tocTitles.push(buf.replace(/\s+/g, " ").trim());
      } else if (inLabel && t.type === "text") buf += t.text;
    }
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
