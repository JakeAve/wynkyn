import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { strFromU8, unzipSync } from "fflate";
import {
  buildEpub,
  exportEpub,
  navList,
  splitBlocks,
  stableIdentifier,
  toXhtml,
} from "./epub-export.ts";
import type { TocRow } from "../renderer/render.ts";

const ROOT = new URL("./testdata", import.meta.url).pathname;
const CORPUS = new URL("../testdata", import.meta.url).pathname;

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

// Well-formedness without an XML parser: tags balance, void tags self-close,
// every & starts an entity.
function assertWellFormed(name: string, xml: string): void {
  assert(
    !/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(xml),
    `${name}: bare &`,
  );
  const stack: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g, "");
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, close, tag, selfClose] = m;
    if (selfClose) continue;
    if (name.endsWith(".xhtml")) {
      assert(!VOID.has(tag!), `${name}: <${tag}> not self-closed`);
    }
    if (close) assertEquals(stack.pop(), tag, `${name}: mismatched </${tag}>`);
    else stack.push(tag!);
  }
  assertEquals(stack, [], `${name}: unclosed tags`);
}

function read(epub: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(epub)).map(([k, v]) => [k, strFromU8(v)]),
  );
}

// Every href="file#id" in the package points at an id in that file.
function assertLinksResolve(files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith(".xhtml")) continue;
    for (const [, href] of text.matchAll(/href="([^"]*#[^"]*)"/g)) {
      const [file, id] = href!.split("#");
      const target = files[`OEBPS/${file}`];
      assert(target, `${name}: link to missing file ${file}`);
      assert(target.includes(`id="${id}"`), `${name}: #${id} not in ${file}`);
    }
  }
}

Deno.test("splitBlocks: one chunk per top-level block; endnotes stay with theirs", () => {
  const html = '<article class="bml"><section id="a"><p>x<br>y</p></section>' +
    '<aside class="notes"><div class="note" id="note-1">n</div></aside>' +
    '<section id="b"><img src="i.png" alt=""><section id="c"></section></section></article>';
  const blocks = splitBlocks(html);
  assertEquals(blocks.length, 2);
  assert(blocks[0]!.endsWith("</aside>"));
  assertEquals(
    blocks[1],
    '<section id="b"><img src="i.png" alt=""><section id="c"></section></section>',
  );
});

Deno.test("toXhtml: void tags self-close; note anchors and notes get EPUB types", () => {
  assertEquals(
    toXhtml('a<br>b<img src="x" alt="">'),
    'a<br/>b<img src="x" alt=""/>',
  );
  const out = toXhtml(
    '<sup class="footnote-anchor" id="fnref-a"><a href="c.xhtml#note-a">1</a></sup>' +
      '<div class="note" id="note-a">n</div>',
  );
  assertStringIncludes(out, '<a epub:type="noteref" href="c.xhtml#note-a">');
  assertStringIncludes(
    out,
    '<div epub:type="footnote" class="note" id="note-a">',
  );
});

Deno.test("navList: parts hold their chapters, chapters their headings", () => {
  const rows: TocRow[] = [
    { cls: "toc-front", href: "matter-preface", label: "Preface" },
    { cls: "toc-part", href: "p1", label: "Part One", number: "I" },
    { cls: "toc-chapter in-part", href: "c1", label: "One", number: "1." },
    { cls: "toc-heading in-part", href: "h1", label: "A heading" },
    { cls: "toc-chapter in-part", href: "c2", label: "", number: "2." },
    { cls: "toc-back", href: "matter-appendix", label: "Appendix" },
  ];
  assertEquals(
    navList(rows, (id) => `${id}.xhtml#${id}`),
    "<ol>" +
      '<li><a href="matter-preface.xhtml#matter-preface">Preface</a></li>' +
      '<li><a href="p1.xhtml#p1">I Part One</a><ol>' +
      '<li><a href="c1.xhtml#c1">1. One</a><ol>' +
      '<li><a href="h1.xhtml#h1">A heading</a></li></ol></li>' +
      '<li><a href="c2.xhtml#c2">2.</a></li></ol></li>' +
      '<li><a href="matter-appendix.xhtml#matter-appendix">Appendix</a></li>' +
      "</ol>",
  );
});

Deno.test("stableIdentifier: the same seed gives the same urn:uuid", async () => {
  const a = await stableIdentifier("demo-book/");
  assertEquals(a, await stableIdentifier("demo-book/"));
  assert(
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(a),
    a,
  );
  assert(a !== await stableIdentifier("demo-book/pocket"));
});

Deno.test("buildEpub: cover page first in the spine, cover image marked", () => {
  const files = read(buildEpub({
    html:
      '<article class="bml"><section class="chapter" id="one"><p>Hi</p></section></article>',
    css: "",
    title: "T",
    language: "en",
    identifier: "urn:uuid:x",
    modified: "2026-01-01T00:00:00Z",
    rows: [],
    images: { "images/cover.png": new Uint8Array([1, 2, 3]) },
    cover: "images/cover.png",
  }));
  const opf = files["OEBPS/content.opf"]!;
  assertStringIncludes(
    opf,
    '<spine>\n<itemref idref="cover"/>\n<itemref idref="doc1"/>',
  );
  assertStringIncludes(
    opf,
    'href="images/cover.png" media-type="image/png" properties="cover-image"',
  );
  assertStringIncludes(
    files["OEBPS/cover.xhtml"]!,
    '<img src="images/cover.png" alt=""/>',
  );
  assert(!opf.includes("<dc:creator>"));
  // No contents block in the book: the nav exists for the reader's menu only.
  assert(files["OEBPS/nav.xhtml"]);
  assert(!opf.includes('<itemref idref="nav"/>'));
});

Deno.test("exportEpub: demo-book → a valid package", async () => {
  const out = await Deno.makeTempDir();
  const s = await exportEpub(ROOT, "demo-book", { out });
  assertEquals(s, { file: `${out}/book.epub`, documents: 2, diagnostics: 0 });
  const bytes = await Deno.readFile(s.file);
  // The container rules: `mimetype` first, stored, exactly this content.
  assertEquals(strFromU8(bytes.slice(30, 38)), "mimetype");
  assertEquals(bytes[8]! | bytes[9]! << 8, 0, "mimetype must be stored");
  assertEquals(strFromU8(bytes.slice(38, 58)), "application/epub+zip");
  const files = read(bytes);
  assertStringIncludes(
    files["META-INF/container.xml"]!,
    'full-path="OEBPS/content.opf"',
  );
  const opf = files["OEBPS/content.opf"]!;
  assertStringIncludes(opf, "<dc:title>Demo Book</dc:title>");
  assertStringIncludes(opf, "<dc:creator>Test Author</dc:creator>");
  assertStringIncludes(opf, '<dc:identifier id="pub-id">urn:uuid:');
  for (const [, href] of opf.matchAll(/href="([^"]*)"/g)) {
    assert(files[`OEBPS/${href}`], `manifest item missing from zip: ${href}`);
  }
  assertStringIncludes(
    opf,
    '<spine>\n<itemref idref="doc1"/>\n<itemref idref="doc2"/>\n</spine>',
  );
  assertStringIncludes(opf, 'href="001-matter-title-page.xhtml"');
  assertStringIncludes(opf, 'href="002-one.xhtml"');
  assertStringIncludes(
    files["OEBPS/nav.xhtml"]!,
    '<a href="002-one.xhtml#one">1. Chapter One</a>',
  );
  assertStringIncludes(
    files["OEBPS/002-one.xhtml"]!,
    '<img src="images/ornament.svg" alt="A small ornament"/>',
  );
  assertStringIncludes(files["OEBPS/book.css"]!, 'font-family: "EB Garamond"');
  for (const [name, text] of Object.entries(files)) {
    if (/\.(xhtml|opf|xml)$/.test(name)) assertWellFormed(name, text);
  }
  assertLinksResolve(files);
});

Deno.test("exportEpub: common-sense → the contents page is the nav; links cross files; refs and notes", async () => {
  const out = await Deno.makeTempDir();
  const s = await exportEpub(CORPUS, "common-sense", { out });
  assertEquals(s.diagnostics, 0);
  const files = read(await Deno.readFile(s.file));
  const opf = files["OEBPS/content.opf"]!;
  assertStringIncludes(opf, "<dc:title>Common Sense</dc:title>");
  assertStringIncludes(
    opf,
    '<itemref idref="doc3"/>\n<itemref idref="nav"/>\n<itemref idref="doc5"/>',
  );
  const nav = files["OEBPS/nav.xhtml"]!;
  assertStringIncludes(
    nav,
    '<h1 class="title" data-line="35">Contents</h1><nav epub:type="toc"',
  );
  assertStringIncludes(
    nav,
    '<li><a href="006-part-one.xhtml#part-one">Part I</a><ol><li>',
  );
  // A {ref} names its target instead of a page number.
  assertStringIncludes(
    files["OEBPS/008-matter-appendix.xhtml"]!,
    '<a class="ref" href="006-part-one.xhtml#monarchy">Of Monarchy and Hereditary Succession</a>',
  );
  // Footnotes in the book's metadata become chapter endnotes with popups.
  const part2 = files["OEBPS/007-part-two.xhtml"]!;
  assertStringIncludes(
    part2,
    '<a epub:type="noteref" href="007-part-two.xhtml#note-massanello">1</a>',
  );
  assertStringIncludes(
    part2,
    '<aside class="notes"><div epub:type="footnote" class="note" id="note-massanello"',
  );
  assert(!part2.includes("float: footnote"));
  for (const [name, text] of Object.entries(files)) {
    if (/\.(xhtml|opf|xml)$/.test(name)) assertWellFormed(name, text);
  }
  assertLinksResolve(files);
});

Deno.test("exportEpub: a named edition lands in export/<edition>; a missing book fails", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b/editions`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/b/manuscript.md`,
    "{chapter: one}\n{title}\nOne\n\nText.\n",
  );
  await Deno.writeTextFile(
    `${root}/b/editions/pocket.json`,
    '{"ebook":{"identifier":"urn:isbn:1","language":"es"}}',
  );
  const s = await exportEpub(root, "b", { edition: "pocket" });
  assertEquals(s.file, `${root}/b/export/pocket/book.epub`);
  const opf = read(await Deno.readFile(s.file))["OEBPS/content.opf"]!;
  assertStringIncludes(
    opf,
    '<dc:identifier id="pub-id">urn:isbn:1</dc:identifier>',
  );
  assertStringIncludes(opf, "<dc:language>es</dc:language>");
  await assertRejects(
    () => exportEpub(root, "nope"),
    Error,
    "no such book: nope",
  );
});

Deno.test("exportEpub: the top-level language wins over the older ebook.language", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b`);
  await Deno.writeTextFile(
    `${root}/b/manuscript.md`,
    "{chapter: one}\n{title}\nOne\n\nText.\n",
  );
  await Deno.writeTextFile(
    `${root}/b/metadata.json`,
    '{"language":"fr","ebook":{"language":"es"}}',
  );
  const s = await exportEpub(root, "b");
  const opf = read(await Deno.readFile(s.file))["OEBPS/content.opf"]!;
  assertStringIncludes(opf, "<dc:language>fr</dc:language>");
});

// `brew install epubcheck` to run this one; it is skipped where the tool is absent.
const hasEpubcheck = await (async () => {
  try {
    return (await new Deno.Command("epubcheck", { args: ["--version"] })
      .output()).success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "epubcheck: the corpus export passes the reference validator",
  ignore: !hasEpubcheck,
  async fn() {
    const out = await Deno.makeTempDir();
    const s = await exportEpub(CORPUS, "common-sense", { out });
    const r = await new Deno.Command("epubcheck", { args: [s.file] }).output();
    assert(
      r.success,
      new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
    );
  },
});
