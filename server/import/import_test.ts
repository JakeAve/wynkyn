// server/import/import_test.ts — the import pipeline (spec §7.9) on small
// fixtures, plus the Gutenberg corpus in books/ when it is on disk.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { strToU8, zipSync } from "fflate";
import { parse } from "../../parser/parser.ts";
import { balanceEm } from "./blocks.ts";
import { readText } from "./text.ts";
import { readHtml } from "./html.ts";
import { importSource } from "./mod.ts";
import { parseHeading, structure, titleCase } from "./structure.ts";

const GUTENBERG = `The Project Gutenberg eBook of Tiny Book

Title: Tiny Book

Author: A. Writer

Release date: January 1, 2000 [eBook #99]

Language: English

*** START OF THE PROJECT GUTENBERG EBOOK TINY BOOK ***

TINY BOOK

by A. Writer


CONTENTS

 CHAPTER I.    The Start
 CHAPTER II.   The Middle
 CHAPTER III.  The End


PREFACE

A short word before we begin, with _some emphasis_ in it.


CHAPTER I.
The Start

It was a dark and stormy night; the rain fell in torrents, except at
occasional intervals, when it was checked by a violent gust of wind.

   Roses are red,
   Violets are blue,
       and this line is wrapped
   so is this.

* * *

After the break the story goes on.

[Illustration: The storm]

CHAPTER II.
The Middle

Nothing much happened in the middle.

CHAPTER III.
The End

- not a list item, a dash

1. not a numbered item either

Something that ended.

THE END

*** END OF THE PROJECT GUTENBERG EBOOK TINY BOOK ***

Licence text that must never appear.
`;

Deno.test("text reader: Gutenberg header, contents, two-line headings, verse, breaks", () => {
  const src = readText("tiny.txt", GUTENBERG);
  assertEquals(src.title, "Tiny Book");
  assertEquals(src.author, "A. Writer");
  assertEquals(src.gutenberg, "99");
  const kinds = src.blocks.map((b) => b.kind);
  assert(kinds.includes("toc"), "the contents list is a toc block");
  assertEquals(src.tocTitles.length, 3);
  assert(
    src.tocTitles.every((t, i) =>
      t.includes(["The Start", "The Middle", "The End"][i]!)
    ),
  );
  const heads = src.blocks.filter((b) => b.kind === "heading");
  assertEquals(heads.map((h) => (h as { sub?: string }).sub), [
    undefined,
    undefined,
    "The Start",
    "The Middle",
    "The End",
  ]);
  const verse = src.blocks.find((b) => b.kind === "verse") as {
    lines: string[];
  };
  assertEquals(verse.lines, [
    "Roses are red,",
    "Violets are blue, and this line is wrapped",
    "so is this.",
  ]);
  assert(kinds.includes("break"));
  const img = src.blocks.find((b) => b.kind === "image") as { alt: string };
  assertEquals(img.alt, "The storm");
  const pref = src.blocks.find((b) =>
    b.kind === "para" && b.text.includes("emphasis")
  ) as { text: string };
  assertStringIncludes(pref.text, "{em}some emphasis{/em}");
  assert(
    !src.blocks.some((b) => b.kind === "para" && b.text.includes("Licence")),
  );
});

Deno.test("structure + emit: house shape, front matter, escapes, zero diagnostics", () => {
  const r = importSource("tiny.txt", strToU8(GUTENBERG));
  const m = r.manuscript;
  assertStringIncludes(m, "{matter: half-title}\n{title}\nTiny Book");
  assertStringIncludes(m, "{author}\nA. Writer");
  assertStringIncludes(m, "Sourced from Project Gutenberg eBook #99");
  assertStringIncludes(m, "{matter: preface}\n{title}\nPreface");
  assertEquals((m.match(/^\{chapter: /gm) ?? []).length, 3);
  assertStringIncludes(m, "{chapter: the-start}\n{title}\nThe Start");
  assertStringIncludes(m, "{poem}\nRoses are red,\\\n");
  assertStringIncludes(m, "{break}");
  assertStringIncludes(
    m,
    "{illustration: the-storm | placement: full-page}\nThe storm",
  );
  assertStringIncludes(m, "\\- not a list item");
  assertStringIncludes(m, "\\1. not a numbered");
  const body = m.replace(/^%%.*$/gm, "");
  assert(!body.includes("THE END"), "THE END is dropped from the text");
  assert(
    !m.includes("TINY BOOK\n"),
    "the title line before the first chapter is dropped",
  );
  assertStringIncludes(
    m,
    "%% 3 chapters from CHAPTER-style lines, checked against the file’s contents.",
  );
  assertStringIncludes(m, "{matter: colophon}");
  assertEquals(parse(m).diagnostics, []);
  // the first paragraph of each chapter and of the preface gets a dropcap
  assertEquals((m.match(/^\{dropcap\}/gm) ?? []).length, 4);
});

Deno.test("structure: readings and options", () => {
  const src = readText("tiny.txt", GUTENBERG);
  const auto = structure(src);
  assert(auto.readings.some((r) => r.label.startsWith("Verse")));
  assert(auto.readings.some((r) => r.options.chapters === "none"));
  const none = structure(src, { chapters: "none" });
  assertEquals(none.body.length, 1);
  assertEquals(none.body[0]!.kind, "chapter");
  const prose = structure(src, { verse: false });
  const all = prose.body.flatMap((n) => n.kind === "chapter" ? n.content : []);
  assert(!all.some((b) => b.kind === "verse"));
  assert(
    all.some((b) =>
      b.kind === "para" && b.text.startsWith("Roses are red, Violets")
    ),
  );
});

Deno.test("parseHeading and titleCase", () => {
  assertEquals(parseHeading("CHAPTER 4. The Carpet-Bag."), {
    label: "Chapter 4",
    title: "The Carpet-Bag",
    num: 4,
  });
  assertEquals(parseHeading("STAVE I:  MARLEY'S GHOST"), {
    label: "Stave 1",
    title: "Marley's Ghost",
    num: 1,
  });
  assertEquals(parseHeading("Letter 2"), {
    label: "Letter 2",
    title: undefined,
    num: 2,
  });
  assertEquals(parseHeading("CHAPTER I.", "Down the Rabbit-Hole"), {
    label: "Chapter 1",
    title: "Down the Rabbit-Hole",
    num: 1,
  });
  assertEquals(parseHeading("THE SISTERS"), { title: "The Sisters" });
  assertEquals(parseHeading("BOOK IV.  CHILDREN OF ADAM"), {
    label: "Book 4",
    title: "Children of Adam",
    num: 4,
  });
  assertEquals(
    titleCase("THE FIRST OF THE THREE SPIRITS"),
    "The First of the Three Spirits",
  );
  assertEquals(titleCase("Mixed Case Stays"), "Mixed Case Stays");
});

Deno.test("balanceEm closes spans at line ends", () => {
  assertEquals(balanceEm(["{em}one", "two", "three{/em} four"]), [
    "{em}one{/em}",
    "{em}two{/em}",
    "{em}three{/em} four",
  ]);
  assertEquals(balanceEm(["plain", "{/em}"]), ["plain"]);
});

const XHTML =
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Doc</title></head><body>
<h2 id="a"><a id="x"/>CHAPTER I.<br/>Down the Hole</h2>
<p>Alice was <i>very</i> tired &amp; bored.</p>
<p class="poem">Twinkle, twinkle,<br/>little <i>bat!<br/>How I</i> wonder</p>
<blockquote><p>A quoted line.</p></blockquote>
<hr/>
<p><img src="../images/pic.jpg" alt="A picture"/></p>
<table><tr><td>skipped</td></tr></table>
</body></html>`;

Deno.test("html reader: headings, emphasis, br verse, quotes, images", () => {
  const { title, blocks } = readHtml(XHTML);
  assertEquals(title, "Doc");
  assertEquals(blocks[0], {
    kind: "heading",
    level: 2,
    text: "CHAPTER I. Down the Hole",
  });
  assertEquals(blocks[1], {
    kind: "para",
    text: "Alice was {em}very{/em} tired & bored.",
  });
  assertEquals(blocks[2], {
    kind: "verse",
    lines: [
      "Twinkle, twinkle,",
      "little {em}bat!{/em}",
      "{em}How I{/em} wonder",
    ],
  });
  assertEquals(blocks[3], { kind: "quote", text: "A quoted line." });
  assertEquals(blocks[4], { kind: "break" });
  assertEquals(blocks[5], {
    kind: "image",
    src: "../images/pic.jpg",
    alt: "A picture",
  });
  assertEquals(blocks.length, 6);
});

Deno.test("epub reader: package metadata, nav, spine order, images", () => {
  const page = (h: string, body: string) =>
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><h2>${h}</h2>${body}</body></html>`;
  const files = {
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    "OEBPS/content.opf": strToU8(
      `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Two Chapters</dc:title><dc:creator>B. Author</dc:creator><dc:identifier>http://www.gutenberg.org/123</dc:identifier><dc:date>2001-01-01</dc:date></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/pic.jpg" media-type="image/jpeg"/></manifest>
<spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>`,
    ),
    "OEBPS/nav.xhtml": strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="text/c2.xhtml">Second</a></li><li><a href="text/c1.xhtml">First</a></li></ol></nav></body></html>`,
    ),
    "OEBPS/text/c1.xhtml": strToU8(page("First", "<p>One.</p>")),
    "OEBPS/text/c2.xhtml": strToU8(
      page(
        "Second",
        `<p>Two.</p><p><img src="../images/pic.jpg" alt="Pic"/></p>`,
      ),
    ),
    "OEBPS/images/pic.jpg": new Uint8Array([1, 2, 3]),
  };
  const r = importSource("two.epub", zipSync(files));
  assertEquals(r.title, "Two Chapters");
  assertEquals(r.author, "B. Author");
  assertEquals(r.outline.src.gutenberg, "123");
  assertEquals(
    r.outline.src.year,
    undefined,
    "a Gutenberg dc:date is the release date, not publication",
  );
  assertEquals(r.outline.src.tocTitles, ["Second", "First"]);
  const chapters = r.manuscript.match(/^\{chapter: .*$/gm);
  assertEquals(
    chapters,
    ["{chapter: second}", "{chapter: first}"],
    "spine order, not manifest order",
  );
  assertEquals(Object.keys(r.images), ["images/pic.jpg"]);
  assertStringIncludes(
    r.manuscript,
    "{illustration: pic | placement: full-page}\nPic",
  );
  assertEquals(parse(r.manuscript).diagnostics, []);
});

Deno.test("structure: BOOK headings above chapters become parts", () => {
  const text = [
    "BOOK I",
    "",
    "Poem One",
    "",
    "  line a",
    "  line b",
    "",
    "Poem Two",
    "",
    "  line c",
    "  line d",
    "",
    "BOOK II",
    "",
    "Poem Three",
    "",
    "  line e",
    "  line f",
    "",
    "Poem Four",
    "",
    "  line g",
    "  line h",
    "",
  ].join("\n");
  // In HTML both levels are h2; the text reader only marks the BOOK lines.
  const html = text.split("\n\n").map((p) =>
    /^BOOK|^Poem/.test(p)
      ? `<h2>${p}</h2>`
      : `<p>${p.trim().replace(/\n\s*/g, "<br/>")}</p>`
  ).join("");
  const { blocks } = readHtml(`<html><body>${html}</body></html>`);
  const o = structure({ name: "x.html", tocTitles: [], blocks, images: {} });
  assertEquals(o.body.map((n) => n.kind), ["part", "part"]);
  assertEquals((o.body[0] as { chapters: unknown[] }).chapters.length, 2);
  assert(o.readings.some((r) => r.label === "No parts"));
  const flat = structure(
    { name: "x.html", tocTitles: [], blocks, images: {} },
    { parts: false },
  );
  assertEquals(
    flat.body.length,
    6,
    "BOOK headings become chapters too when parts are off",
  );
});

// ---- the Gutenberg corpus, when the books are on disk ----------------------
const CORPUS: [string, string, number, number][] = [
  // slug, file, chapters, parts
  ["a-christmas-carol", "download.txt", 5, 0],
  ["pride-and-prejudice", "download.txt", 61, 0],
  ["pride-and-prejudice", "download.epub", 61, 0],
  ["moby-dick", "download.txt", 139, 0], // 135 + Etymology, Extracts (twice in the text), Epilogue
  ["moby-dick", "download.epub", 138, 0],
  ["frankenstein", "download.txt", 28, 0], // 4 letters + 24 chapters
  ["frankenstein", "download.epub", 28, 0],
  ["dubliners", "download.txt", 16, 0], // 15 stories + one in-story headline the contents also lists
  ["dubliners", "download.epub", 15, 0],
  ["leaves-of-grass", "download.txt", 39, 0], // poem titles are plain lines in the text
  ["leaves-of-grass", "download.epub", 341, 34],
  ["alice-in-wonderland", "download.txt", 12, 0],
  ["alice-in-wonderland", "download.epub", 12, 0],
];
for (const [slug, file, chapters, parts] of CORPUS) {
  const path = `books/${slug}/${file}`;
  let bytes: Uint8Array | null = null;
  try {
    bytes = Deno.readFileSync(path);
  } catch {
    // not on this machine
  }
  Deno.test({
    name:
      `corpus: ${slug}/${file} → ${chapters} chapters, ${parts} parts, 0 diagnostics`,
    ignore: bytes === null,
    fn() {
      const r = importSource(file, bytes!);
      assertEquals(
        (r.manuscript.match(/^\{chapter: /gm) ?? []).length,
        chapters,
      );
      assertEquals((r.manuscript.match(/^\{part: /gm) ?? []).length, parts);
      assertEquals(parse(r.manuscript).diagnostics, []);
      assert(
        !/\*\*\* ?(START|END) OF|full project gutenberg|gutenberg\.org\/license/i
          .test(r.manuscript),
        "no Gutenberg boilerplate in the text",
      );
    },
  });
}
