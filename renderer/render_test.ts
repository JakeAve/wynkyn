import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "../parser/parser.ts";
import type { Metadata } from "../metadata/types.ts";
import {
  formatNumber,
  render as renderLined,
  renderSegments,
} from "./render.ts";

// Existing tests assert markup shape; data-line has its own test at the bottom.
const render: typeof renderLined = (doc, opts) =>
  renderLined(doc, opts).replace(/ data-line="\d+"/g, "");

Deno.test("formatNumber: all styles", () => {
  assertEquals(formatNumber(4, "arabic"), "4");
  assertEquals(formatNumber(1, "roman-upper"), "I");
  assertEquals(formatNumber(4, "roman-upper"), "IV");
  assertEquals(formatNumber(14, "roman-lower"), "xiv");
  assertEquals(formatNumber(40, "roman-upper"), "XL");
  assertEquals(formatNumber(1990, "roman-upper"), "MCMXC");
  assertEquals(formatNumber(1, "alpha-upper"), "A");
  assertEquals(formatNumber(26, "alpha-lower"), "z");
  assertEquals(formatNumber(27, "alpha-upper"), "AA");
  assertEquals(formatNumber(3, "none"), "");
});

Deno.test("zones, matter classes and ids", () => {
  const html = render(
    parse(
      "{matter: half-title}\n{title}\nCommon Sense\n{chapter: one}\nProse.\n{matter: colophon}\nSet by hand.",
    ),
  );
  assertStringIncludes(html, '<article class="bml">');
  assertStringIncludes(
    html,
    '<section class="matter matter-half-title matter-display zone-front" id="matter-half-title" data-one-page>',
  );
  assertStringIncludes(
    html,
    '<section class="chapter zone-body body-start" id="one">',
  );
  assertStringIncludes(
    html,
    '<section class="matter matter-colophon matter-display zone-back" id="matter-colophon" data-one-page>',
  );
  assert(!html.includes('class="zone'), "no zone wrapper divs");
});

Deno.test("one-page: display matter by default, any matter by the key", () => {
  const doc = parse(
    "{matter: half-title}\n{title}\nT\n{matter: preface}\nP.\n{chapter: one}\nX.",
  );
  const marked = (html: string) =>
    [...html.matchAll(/id="([^"]*)"[^>]* data-one-page>/g)].map((m) => m[1]);
  assertEquals(marked(render(doc)), ["matter-half-title"]);
  assertEquals(
    marked(render(doc, { onePage: { "half-title": false, preface: true } })),
    ["matter-preface"],
  );
});

Deno.test("zone class goes on parts, not on the chapters inside them", () => {
  const html = render(parse("{part: p}\n{chapter: a}\nX\n{chapter: b}\nY"));
  assertStringIncludes(
    html,
    '<section class="part zone-body body-start" id="p">',
  );
  assertStringIncludes(html, '<section class="chapter" id="a">');
  assertEquals(html.match(/zone-body/g)?.length, 1);
});

Deno.test("chapter: id from slug, numbered title per opts.numbering", () => {
  const html = render(
    parse("{chapter: thaw}\n{title}\nThe First Thaw\n\nProse."),
    {
      numbering: {
        chapters: { style: "roman-upper", show: true, prefix: "", suffix: "." },
      },
    },
  );
  assertStringIncludes(
    html,
    '<section class="chapter zone-body body-start" id="thaw">',
  );
  assertStringIncludes(html, '<div class="number">I.</div>');
  assertStringIncludes(html, '<h1 class="title">The First Thaw</h1>');
});

Deno.test("chapter numbers continue across parts; parts numbered separately", () => {
  const html = render(
    parse(
      "{part: one}\n{chapter: a}\nx\n{chapter: b}\nx\n{part: two}\n{chapter: c}\nx",
    ),
    {
      numbering: {
        chapters: { style: "arabic", show: true },
        parts: { style: "roman-upper", show: true, prefix: "Part " },
      },
    },
  );
  assertStringIncludes(
    html,
    '<section class="part zone-body body-start" id="one">',
  );
  assertStringIncludes(html, '<div class="number">Part I</div>');
  assertStringIncludes(html, '<div class="number">Part II</div>');
  // chapter c is the third chapter overall
  const cIdx = html.indexOf('id="c"');
  assertStringIncludes(
    html.slice(cIdx, cIdx + 200),
    '<div class="number">3</div>',
  );
});

Deno.test("numbering show:false suppresses the number div", () => {
  const html = render(parse("{chapter: a}\n{title}\nT\n\nx"), {
    numbering: { chapters: { style: "arabic", show: false } },
  });
  assert(!html.includes('class="number"'));
});

Deno.test("inline rendering: em, hard break, HTML escaping", () => {
  const html = render(
    parse("{chapter: a}\nShe saw the {em}Queen Mary{/em} & waved\\\ntwice."),
  );
  assertStringIncludes(html, "<em>Queen Mary</em> &amp; waved<br>twice.");
});

Deno.test("dropcap wraps first letter in a span", () => {
  const html = render(parse("{chapter: a}\n{dropcap}\nThe morning came."));
  assertStringIncludes(
    html,
    '<p class="has-dropcap"><span class="dropcap">T</span>he morning came.</p>',
  );
});

Deno.test("dropcap correctly splits when the first inline is emphasized", () => {
  const html = render(
    parse("{chapter: a}\n{dropcap}\n{em}The{/em} morning came."),
  );
  assertStringIncludes(
    html,
    '<p class="has-dropcap"><span class="dropcap">T</span><em>he</em> morning came.</p>',
  );
});

Deno.test("dropcap correctly escapes a first character that needs HTML escaping", () => {
  const html = render(parse("{chapter: a}\n{dropcap}\n& so it began."));
  assertStringIncludes(
    html,
    '<p class="has-dropcap"><span class="dropcap">&amp;</span> so it began.</p>',
  );
});

Deno.test("verses render numbers from start (§3.5.7)", () => {
  const html = render(
    parse("{chapter: a}\n{verses: gen-1 | start: 3}\nAnd God said.\n{/verses}"),
  );
  assertStringIncludes(html, '<div class="verses" id="gen-1">');
  // no space between the number and the text — a justified line would stretch it
  assertStringIncludes(
    html,
    '<p class="verse"><span class="number">3</span>And God said.</p>',
  );
});

Deno.test("a dropcap verse keeps its verse number and class (§3.5.7)", () => {
  const html = render(
    parse(
      "{chapter: a}\n{verses: gen-1 | start: 3}\n{dropcap}\nAnd God said.\n{/verses}",
    ),
  );
  assertStringIncludes(
    html,
    '<p class="has-dropcap verse"><span class="number">3</span><span class="dropcap">A</span>nd God said.</p>',
  );
});

Deno.test("a paragraph after a title or a break is marked .lead, not indented", () => {
  const html = render(
    parse(
      "{matter: preface}\n{title}\nP\n\nFirst.\n\n{break}\n\nAfter.\n\nPlain.",
    ),
  );
  assertStringIncludes(html, '<p class="lead">First.</p>');
  assertStringIncludes(html, '<p class="lead">After.</p>');
  assertStringIncludes(html, "<p>Plain.</p>");
});

Deno.test("a paragraph after a heading or first in its container is .lead", () => {
  const html = render(
    parse(
      "{matter: dedication}\nFor Zelda\n\n{chapter: a}\n{title}\nA\n\nOne.\n\n" +
        "{heading}\nH\n\nAfter heading.\n\n{sidebar}\nBoxed.\n\nSecond.\n{/sidebar}\n\n" +
        "Resumed.",
    ),
  );
  assertStringIncludes(html, '<p class="lead">For Zelda</p>');
  assertStringIncludes(html, '<p class="lead">After heading.</p>');
  assertStringIncludes(html, '<p class="lead">Boxed.</p>');
  assertStringIncludes(html, "<p>Second.</p>");
  // After a block the text may be a new paragraph; it keeps its indent.
  assertStringIncludes(html, "<p>Resumed.</p>");
});

Deno.test("endnotes collect at the end of the structural block", () => {
  const html = render(
    parse(
      "{chapter: a}\nPoor harvest.{footnote: h43}\n\n{note: h43}\nRecords show 40%.",
    ),
    { notes: { placement: "endnote" } },
  );
  assertStringIncludes(
    html,
    '<sup class="footnote-anchor" id="fnref-h43"><a href="#note-h43">1</a></sup>',
  );
  // A top-level sibling of the chapter, so it carries the zone (page name) too:
  // without it Paged.js breaks before the notes on the page-name change.
  assertStringIncludes(html, '<aside class="notes zone-body">');
  assertStringIncludes(html, '<div class="note" id="note-h43">');
});

Deno.test("footnote placement inlines the note at the anchor", () => {
  const html = render(
    parse(
      "{chapter: a}\nPoor harvest.{footnote: h43}\n\n{note: h43}\nRecords show 40%.",
    ),
    { notes: { placement: "footnote" } },
  );
  assertStringIncludes(
    html,
    '<span class="note" id="note-h43">Records show 40%.</span>',
  );
  assert(!html.includes("<aside"));
});

Deno.test("ref renders as an empty anchor the page map fills (§3.8, §4.10 item 9)", () => {
  const html = render(
    parse(
      "{chapter: thaw}\nx\n{chapter: b}\nAs discussed in {ref: thaw}, it turned.",
    ),
  );
  assertStringIncludes(html, '<a class="ref" href="#thaw"></a>');
});

Deno.test("title page: publisher, place and year render last, together in .imprint (§3.4.2)", () => {
  const html = render(parse(
    [
      "{matter: title-page}",
      "{title}",
      "The Book",
      "{publisher}",
      "Thornfield Press",
      "{publisher-location}",
      "Edinburgh",
      "{author}",
      "Jane Ellory",
      "{year}",
      "2024",
    ].join("\n"),
  ));
  assertStringIncludes(
    html,
    '<p class="author">Jane Ellory</p><div class="imprint"><p class="publisher">Thornfield Press</p><p class="publisher-location">Edinburgh</p><p class="year">2024</p></div></section>',
  );
});

const TOC_BOOK = [
  "{matter: title-page}",
  "{title}",
  "The Book",
  "{matter: toc}",
  "{title}",
  "Contents",
  "{matter: preface}",
  "{title}",
  "Preface",
  "",
  "p",
  "{part: one}",
  "{title}",
  "Before the Frost",
  "{subtitle}",
  "A beginning",
  "{chapter: thaw}",
  "{title}",
  "The First Thaw",
  "",
  "x",
  "{chapter: crossing}",
  "",
  "y",
  "{matter: appendix}",
  "{title}",
  "Family Tree",
  "{matter: colophon}",
  "{printer}",
  "Set by hand.",
].join("\n");

Deno.test("toc: rows carry level classes, spans, and an empty page link (§3.4.6)", () => {
  const html = render(parse(TOC_BOOK));
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(
    html,
    '<div class="entry toc-front"><a class="label" href="#matter-preface">Preface</a><span class="leader"></span><a class="page" href="#matter-preface"></a></div>',
  );
  assertStringIncludes(
    html,
    '<div class="entry toc-part"><a class="label" href="#one">Before the Frost</a><span class="subtitle">A beginning</span><span class="leader"></span><a class="page" href="#one"></a></div>',
  );
  assertStringIncludes(
    html,
    '<div class="entry toc-chapter in-part"><a class="label" href="#thaw">The First Thaw</a><span class="leader"></span><a class="page" href="#thaw"></a></div>',
  );
  assertStringIncludes(
    html,
    '<a class="label" href="#matter-appendix">Family Tree</a>',
  );
});

Deno.test("toc: display matter and untitled back matter are not listed", () => {
  const html = render(parse(TOC_BOOK));
  const nav = html.slice(
    html.indexOf('<nav class="toc">'),
    html.indexOf("</nav>"),
  );
  assert(!nav.includes("matter-title-page"));
  assert(!nav.includes("matter-toc"));
  assert(!nav.includes("matter-colophon"));
});

Deno.test("toc: numbers follow numbering.chapters/parts; untitled chapter shows number only", () => {
  const html = render(parse(TOC_BOOK), {
    numbering: {
      chapters: { style: "roman-upper", show: true, suffix: "." },
      parts: { style: "words", show: true, prefix: "Book " },
    },
  });
  assertStringIncludes(
    html,
    '<div class="entry toc-part"><span class="number">Book One</span><a class="label" href="#one">Before the Frost</a>',
  );
  assertStringIncludes(
    html,
    '<span class="number">I.</span><a class="label" href="#thaw">The First Thaw</a>',
  );
  assertStringIncludes(
    html,
    '<span class="number">II.</span><a class="label" href="#crossing"></a>',
  );
});

Deno.test("toc: untitled chapter with no numbering falls back to its slug; flat chapters are not in-part", () => {
  const html = render(
    parse("{matter: toc}\n{title}\nC\n{chapter: crossing}\n\ny"),
  );
  assertStringIncludes(
    html,
    '<div class="entry toc-chapter"><a class="label" href="#crossing">crossing</a>',
  );
});

Deno.test("toc: a matter label is slugified into the id; id and href match", () => {
  const html = render(parse([
    "{matter: toc}",
    "{title}",
    "Contents",
    "{matter: appendix | label: A & B}",
    "{title}",
    "Family Tree",
  ].join("\n")));
  assertStringIncludes(html, 'id="matter-appendix-a-b"');
  assertStringIncludes(html, 'href="#matter-appendix-a-b"');
});

Deno.test("toc: repeated matter ids are numbered so each row finds its own block", () => {
  const html = render(parse([
    "{matter: toc}",
    "{title}",
    "Contents",
    "{matter: appendix}",
    "{title}",
    "One",
    "{matter: appendix}",
    "{title}",
    "Two",
  ].join("\n")));
  assertStringIncludes(html, 'id="matter-appendix"');
  assertStringIncludes(html, 'id="matter-appendix-2"');
  assertStringIncludes(html, 'href="#matter-appendix-2">Two</a>');
});

Deno.test("toc: manual content renders verbatim, no generated nav", () => {
  const html = render(
    parse("{matter: toc}\nChapter One .... 1\n{chapter: a}\nx"),
  );
  assert(!html.includes('<nav class="toc">'));
  assertStringIncludes(html, "Chapter One .... 1");
});

Deno.test("illustration: resolved image vs visible placeholder (§4.10 item 8)", () => {
  const src =
    "{chapter: a}\n{illustration: orchard | placement: full-page}\nThe Orchard";
  const withImg = render(parse(src), {
    images: { orchard: "images/orchard.png" },
  });
  assertStringIncludes(
    withImg,
    '<figure class="illustration placement-full-page" id="orchard">',
  );
  assertStringIncludes(
    withImg,
    '<img src="images/orchard.png" alt="The Orchard">',
  );
  assertStringIncludes(
    withImg,
    '<figcaption class="caption">The Orchard</figcaption>',
  );
  const without = render(parse(src));
  assertStringIncludes(
    without,
    '<div class="illustration-placeholder" data-slug="orchard">' +
      "<span>No image named orchard yet</span><span>Click to add one</span></div>",
  );
  assertStringIncludes(
    render(parse('{chapter: a}\n{illustration: a"b}')),
    'data-slug="a&quot;b"><span>No image named a&quot;b yet</span>',
  );
});

Deno.test("columns: flow uses column-count, parallel uses one div per column", () => {
  const flow = render(
    parse("{chapter: a}\n{columns: 2}\nProse here.\n{/columns}"),
  );
  assertStringIncludes(
    flow,
    '<div class="columns columns-flow" style="column-count: 2">',
  );
  const parallel = render(
    parse("{chapter: a}\n{columns: 2}\nEnglish.\n{col}\nGerman.\n{/columns}"),
  );
  assertStringIncludes(
    parallel,
    '<div class="columns columns-parallel" style="grid-template-columns: repeat(2, 1fr)">',
  );
  assertEquals((parallel.match(/<div class="col">/g) ?? []).length, 2);
});

Deno.test("poem, quote, epigraph, sidebar, pullquote, is, list, break markup", () => {
  const html = render(parse([
    "{chapter: a}",
    "{epigraph}",
    "The water does not ask.",
    "{attribution}",
    "— Proverb",
    "",
    "{quote}",
    "We hold these truths.",
    "",
    "{poem}",
    "The apples fall\\",
    "in rows.",
    "{/poem}",
    "",
    "{sidebar}",
    "An aside.",
    "",
    "{pullquote}",
    "The orchard remembers.",
    "",
    "{is: telegram}",
    "ARRIVED STOP",
    "",
    "- one",
    "- two",
    "",
    "{break: passage-of-years}",
  ].join("\n")));
  assertStringIncludes(html, '<blockquote class="epigraph">');
  assertStringIncludes(html, '<p class="attribution">— Proverb</p>');
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, '<div class="poem">');
  assertStringIncludes(
    html,
    '<p class="stanza">The apples fall<br>in rows.</p>',
  );
  assertStringIncludes(html, '<aside class="sidebar">');
  assertStringIncludes(html, '<aside class="pullquote">');
  assertStringIncludes(html, '<div class="is is-telegram">');
  assertStringIncludes(html, "<ul><li>one</li><li>two</li></ul>");
  assertStringIncludes(
    html,
    '<div class="break break-passage-of-years"></div>',
  );
});

Deno.test("slug with a double-quote character is escaped in id/href attributes, not corrupted", () => {
  const html = render(parse('{chapter: a"b}\nx'));
  assertStringIncludes(html, 'id="a&quot;b"');
  assert(!html.includes('id="a"b"'));
});

Deno.test("ref target slug with a quote character is escaped in the href", () => {
  const html = render(parse('{chapter: safe}\nSee {ref: a"b}.'));
  assertStringIncludes(html, 'href="#a&quot;b"');
});

Deno.test("formatNumber words: spelled out to ninety-nine, digits after (§4.7)", () => {
  assertEquals(formatNumber(1, "words"), "One");
  assertEquals(formatNumber(12, "words"), "Twelve");
  assertEquals(formatNumber(20, "words"), "Twenty");
  assertEquals(formatNumber(21, "words"), "Twenty-One");
  assertEquals(formatNumber(99, "words"), "Ninety-Nine");
  assertEquals(formatNumber(100, "words"), "100");
  assertEquals(formatNumber(1, "ordinal"), "First");
  assertEquals(formatNumber(12, "ordinal"), "Twelfth");
  assertEquals(formatNumber(13, "ordinal"), "Thirteenth");
  assertEquals(formatNumber(20, "ordinal"), "Twentieth");
  assertEquals(formatNumber(23, "ordinal"), "Twenty-Third");
  assertEquals(formatNumber(99, "ordinal"), "Ninety-Ninth");
  assertEquals(formatNumber(100, "ordinal"), "100");
});

const HEADINGS_BOOK = [
  "{matter: toc}",
  "{title}",
  "Contents",
  "{part: one}",
  "{title}",
  "Part One",
  "{chapter: govt}",
  "{title}",
  "Of Government",
  "",
  "{heading: origin}",
  "Of its Origin",
  "",
  "p",
  "{heading}",
  "Unslugged",
  "",
  "p",
  "{subheading: minor}",
  "A subheading",
  "",
  "p",
].join("\n");

Deno.test("toc: level-1 slugged headings listed only when toc.headings is true (§4.11)", () => {
  const on = render(parse(HEADINGS_BOOK), { toc: { headings: true } });
  assertStringIncludes(
    on,
    '<a class="page" href="#govt"></a></div><div class="entry toc-heading in-part"><a class="label" href="#origin">Of its Origin</a><span class="leader"></span><a class="page" href="#origin"></a></div>',
  );
  assert(!on.includes("Unslugged</a>"));
  assert(!on.includes('href="#minor"'));

  const off = render(parse(HEADINGS_BOOK));
  assert(!off.includes("toc-heading"));
});

Deno.test("render: blocks carry data-line", () => {
  const html = renderLined(parse([
    "{matter: half-title}", // 1
    "{title}", // 2
    "Orchard", // 3
    "",
    "{chapter: a}", // 5
    "{title}", // 6
    "One", // 7
    "",
    "First paragraph with *em*.", // 9
    "",
    "{heading}", // 11
    "Part I", // 12
    "",
    "{quote}", // 14
    "We hold these truths.", // 15
    "",
    "{poem}", // 17
    "The apples fall\\", // 18
    "in rows.", // 19
    "{/poem}", // 20
    "",
    "- one", // 22
    "- two", // 23
    "",
    "{break}", // 25
  ].join("\n")));
  const lines = (re: RegExp) => [...html.matchAll(re)].map((m) => m[1]);
  assertEquals(lines(/<section class="matter[^>]*data-line="(\d+)"/g), ["1"]);
  assertEquals(lines(/<section class="chapter[^>]*data-line="(\d+)"/g), ["5"]);
  assertEquals(lines(/<h1 class="title" data-line="(\d+)"/g), ["2", "6"]);
  assertEquals(lines(/<p class="lead" data-line="(\d+)"/g), ["9"]);
  assertEquals(lines(/<h3 [^>]*data-line="(\d+)"/g), ["11"]);
  assertEquals(lines(/<blockquote [^>]*data-line="(\d+)"/g), ["14"]);
  assertEquals(lines(/<div class="poem" data-line="(\d+)"/g), ["17"]);
  assertEquals(lines(/<li data-line="(\d+)"/g), ["22", "23"]);
  assertEquals(lines(/<div class="break" data-line="(\d+)"/g), ["25"]);
  assert(!/<(em|br)[^>]*data-line/.test(html), "inline nodes get no attribute");
});

Deno.test("language lands on the article as lang; absent by default", () => {
  const doc = parse("{chapter: one}\n{title}\nOne\n\nText.\n");
  assertStringIncludes(
    render(doc, { language: "es" }),
    '<article class="bml" lang="es">',
  );
  assertStringIncludes(render(doc), '<article class="bml">');
});

Deno.test("notes: a repeated anchor reuses its number; an unresolved one is left out", () => {
  const html = render(parse([
    "{chapter: a}",
    "A{footnote: a} B{footnote: missing} C{footnote: a} D{footnote: b}",
    "",
    "{note: a}",
    "first a",
    "",
    "{note: a}",
    "second a",
    "",
    "{note: b}",
    "bee",
  ].join("\n")));
  assertStringIncludes(
    html,
    'A<sup class="footnote-anchor" id="fnref-a"><a href="#note-a">1</a></sup> B C<sup class="footnote-anchor"><a href="#note-a">1</a></sup> D<sup class="footnote-anchor" id="fnref-b"><a href="#note-b">2</a></sup>',
  );
  // §3.2.4: the first of two notes with one slug wins.
  assertStringIncludes(
    html,
    '<div class="note" id="note-a"><sup>1</sup> first a</div>',
  );
  assertStringIncludes(
    html,
    '<div class="note" id="note-b"><sup>2</sup> bee</div>',
  );
  assert(!html.includes("second a"));
});

Deno.test("notes: a note that footnotes itself, or a cycle, renders without recursing", () => {
  const src = [
    "{chapter: a}",
    "X{footnote: s} Y{footnote: p}",
    "",
    "{note: s}",
    "loop{footnote: s}",
    "",
    "{note: p}",
    "to q{footnote: q}",
    "",
    "{note: q}",
    "back to p{footnote: p}",
  ].join("\n");
  for (const placement of ["footnote", "endnote"] as const) {
    const html = render(parse(src), { notes: { placement } });
    assertStringIncludes(html, "loop");
    assertStringIncludes(html, "back to p");
  }
});

Deno.test("images: the src is escaped into its attribute", () => {
  const html = render(
    parse("{chapter: a}\n{illustration: x}\n\n{dropcap | image: t}\nThe end."),
    { images: { x: 'a".png" onerror="alert(1)', t: 'b".png' } },
  );
  assertStringIncludes(html, 'src="a&quot;.png&quot; onerror=&quot;alert(1)"');
  assertStringIncludes(html, 'src="b&quot;.png"');
});

Deno.test("dropcap image stands for the first letter (§3.5.4)", () => {
  const html = render(
    parse("{chapter: a}\n{dropcap | image: initial-t}\nThe morning came."),
    { images: { "initial-t": "images/initial-t.png" } },
  );
  assertStringIncludes(
    html,
    '<img class="dropcap" src="images/initial-t.png" alt="T">he morning came.',
  );
});

Deno.test("toc: a titled colophon is not listed (§3.7); an open matter type is", () => {
  const html = render(parse([
    "{matter: toc}",
    "{title}",
    "Contents",
    "{chapter: one}",
    "Prose.",
    "{matter: afterword}",
    "{title}",
    "Afterword",
    "{matter: colophon}",
    "{title}",
    "Colophon",
  ].join("\n")));
  assertStringIncludes(html, 'href="#matter-afterword">Afterword</a>');
  assert(!html.includes('href="#matter-colophon"'));
  assert(!html.includes("matter-afterword matter-display"));
});

// ── segments ────────────────────────────────────────────────────────────────
const SEGMENT_BOOK = [
  "{matter: half-title}",
  "{title}",
  "Orchard",
  "{matter: copyright}",
  "Copyright 1900.",
  "{matter: toc}",
  "{title}",
  "Contents",
  "{matter: preface}",
  "{title}",
  "Preface",
  "",
  "See {ref: crossing}.",
  "{chapter: prelude}",
  "Before.",
  "{part: one}",
  "{title}",
  "Before the Frost",
  "{chapter: thaw}",
  "{title}",
  "The First Thaw",
  "",
  "x{footnote: n1}",
  "",
  "{note: n1}",
  "A note.",
  "{chapter: crossing}",
  "",
  "y",
  "{matter: appendix}",
  "{title}",
  "Family Tree",
  "{matter: colophon}",
  "Set by hand.",
].join("\n");

// Undo the wrappers: joined, the segments' sections are render()'s.
const joined = (segs: { html: string }[]) =>
  segs.map((s) => s.html.replace(/^<article[^>]*>|<\/article>$/g, "")).join("")
    .replace(
      /<\/section><section class="part zone-body" data-split-from="[^"]*">/g,
      "",
    );

Deno.test("renderSegments: one per section in book order; joined they are render()'s", () => {
  const doc = parse(SEGMENT_BOOK);
  const segs = renderSegments(doc, { language: "en" });
  assertEquals(segs.map((s) => s.id), [
    "matter-half-title",
    "matter-copyright",
    "matter-toc",
    "matter-preface",
    "prelude",
    "one",
    "thaw",
    "crossing",
    "matter-appendix",
    "matter-colophon",
  ]);
  assertEquals(segs.map((s) => s.line), [1, 4, 6, 9, 14, 16, 19, 27, 30, 33]);
  for (const s of segs) {
    assert(s.html.startsWith('<article class="bml" lang="en">'), s.id);
  }
  const whole = renderLined(doc, { language: "en" });
  assertEquals(
    joined(segs),
    whole.replace(/^<article[^>]*>|<\/article>$/g, ""),
  );
  // Lines stay absolute.
  assertStringIncludes(segs[7]!.html, 'data-line="29"');
});

Deno.test("renderSegments: a chapter in a part sits in a split-from part wrapper", () => {
  const segs = renderSegments(parse(SEGMENT_BOOK));
  const part = segs.find((s) => s.id === "one")!;
  assert(part.html.startsWith(
    '<article class="bml"><section class="part zone-body" id="one" data-line="16">',
  ));
  assert(part.html.endsWith("</section></article>"));
  const thaw = segs.find((s) => s.id === "thaw")!;
  assert(thaw.html.startsWith(
    '<article class="bml"><section class="part zone-body" data-split-from="one"><section class="chapter" id="thaw" data-line="19">',
  ));
  // The chapter's endnotes stay inside the wrapper.
  assert(thaw.html.endsWith("</aside></section></article>"));
  // A chapter outside a part is not wrapped.
  const prelude = segs.find((s) => s.id === "prelude")!;
  assert(!prelude.html.includes("data-split-from"));
});

Deno.test("renderSegments: reads lists TOC and {ref} targets; ids every rendered id", () => {
  const segs = renderSegments(parse(SEGMENT_BOOK));
  const byId = (id: string) => segs.find((s) => s.id === id)!;
  assertEquals(byId("matter-toc").reads, [
    "matter-preface",
    "prelude",
    "one",
    "thaw",
    "crossing",
    "matter-appendix",
  ]);
  assertEquals(byId("matter-preface").reads, ["crossing"]);
  assertEquals(byId("thaw").reads, []);
  assertEquals(byId("thaw").ids, ["thaw", "fnref-n1", "note-n1"]);
  assertEquals(byId("one").ids, ["one"]);
  assertEquals(
    segs.flatMap((s) => s.ids).sort(),
    [...renderLined(parse(SEGMENT_BOOK)).matchAll(/ id="([^"]*)"/g)]
      .map((m) => m[1]!).sort(),
  );
});

Deno.test("renderSegments: opens follows base.css per section type", () => {
  const segs = renderSegments(parse(SEGMENT_BOOK));
  assertEquals(
    Object.fromEntries(segs.map((s) => [s.id, s.opens])),
    {
      "matter-half-title": "right",
      "matter-copyright": "page",
      "matter-toc": "right",
      "matter-preface": "right",
      prelude: "right", // body-start
      one: "right",
      thaw: "page",
      crossing: "page",
      "matter-appendix": "right",
      "matter-colophon": "page",
    },
  );
});

Deno.test("renderSegments: elements keys override opens, later keys winning", () => {
  const doc = parse(SEGMENT_BOOK);
  const opens = (elements: Record<string, Record<string, string>>) =>
    Object.fromEntries(
      renderSegments(doc, { elements }).map((s) => [s.id, s.opens]),
    );
  const a = opens({
    matter: { "break-before": "page" },
    preface: { "break-before": "verso" },
    chapter: { "break-before": "recto" },
    colophon: { "break-before": "left" },
  });
  assertEquals(a["matter-half-title"], "page");
  assertEquals(a["matter-preface"], "left");
  assertEquals(a["crossing"], "right");
  assertEquals(a["matter-colophon"], "left");
  // prose-matter reaches the preface; a later `matter` key wins over it.
  assertEquals(
    opens({
      "prose-matter": { "break-before": "left" },
      matter: { "break-before": "page" },
    })["matter-preface"],
    "page",
  );
  // The previous section's break-after forces a side onto a plain break.
  assertEquals(
    opens({ prelude: { "break-after": "right" } })["one"],
    "right",
  );
  assertEquals(
    opens({ copyright: { "break-after": "left" } })["matter-toc"],
    "right",
  );
  assertEquals(
    opens({ "half-title": { "break-after": "left" } })["matter-copyright"],
    "left",
  );
});

Deno.test("renderSegments: a break value that isn't a page or a side merges", () => {
  const doc = parse(SEGMENT_BOOK);
  const ids = (v: string) =>
    renderSegments(doc, { elements: { chapter: { "break-before": v } } })
      .map((s) => s.id);
  const runOn = ids("auto");
  for (const v of ["unset", "initial", "inherit", "revert", "revert-layer"]) {
    assertEquals(ids(v), runOn, v);
  }
  assertEquals(ids("sideways"), runOn); // CSS drops it; merging is still safe
  assertEquals(ids("all"), runOn); // Paged.js breaks on none of these
  assertEquals(ids(" Recto "), renderSegments(doc).map((s) => s.id));
  // A break-after it can't read forces nothing: the next opens as base.css says.
  assertEquals(
    renderSegments(doc, { elements: { prelude: { "break-after": "unset" } } })
      .find((s) => s.id === "one")!.opens,
    "right",
  );
});

Deno.test("renderSegments: the endnotes' break-after reaches the next section", () => {
  const doc = parse(SEGMENT_BOOK);
  const opens = (elements: Record<string, Record<string, string>>) =>
    renderSegments(doc, { elements }).find((s) => s.id === "crossing")!.opens;
  // thaw ends with its endnotes: theirs is the break after it.
  assertEquals(opens({ notes: { "break-after": "left" } }), "left");
  // thaw's own break-after falls before its endnotes, inside its segment.
  assertEquals(opens({ chapter: { "break-after": "left" } }), "page");
  // Run on, the endnotes' break still cuts where the flow breaks.
  const segs = renderSegments(doc, {
    elements: {
      chapter: { "break-before": "auto" },
      notes: { "break-after": "page" },
    },
  });
  assertEquals(segs.find((s) => s.id === "crossing")?.opens, "page");
});

Deno.test("renderSegments: a forced break-after below a section merges", () => {
  const doc = parse(SEGMENT_BOOK);
  const ids = (elements: Metadata["elements"]) =>
    renderSegments(doc, { elements }).map((s) => s.id);
  const all = ids({});
  // Last in its section, it would break before the next one: the cut can't
  // know, so nothing is cut.
  for (
    const elements of [
      { paragraph: { "break-after": "right" } },
      { title: { "break-after": "page" } },
      { footnote: { "break-after": "left" } },
      { chapter: { title: { "break-after": "verso" } } },
      { part: { chapter: { dropcap: { "break-after": "always" } } } },
    ] as Metadata["elements"][]
  ) {
    assertEquals(
      ids(elements),
      ["matter-half-title"],
      JSON.stringify(elements),
    );
  }
  assertEquals(
    renderSegments(doc, {
      elements: { paragraph: { "break-after": "page" } },
    })[0]!.html,
    renderLined(doc),
  );
  // A break-before inside a segment is Paged.js's to make; so is a deep
  // break-after that forces nothing, and a section's own (handled above).
  assertEquals(ids({ paragraph: { "break-before": "right" } }), all);
  assertEquals(ids({ chapter: { title: { "break-before": "page" } } }), all);
  assertEquals(ids({ paragraph: { "break-after": "avoid" } }), all);
  assertEquals(ids({ chapter: { "break-after": "page" } }), all);
  assertEquals(ids({ p: { "break-after": "page" } }), all); // reaches nothing
  // An {is} block sits inside a section, so its forced break-after merges too.
  const isIds = (is: Metadata["is"]) =>
    renderSegments(doc, { is }).map((s) => s.id);
  assertEquals(isIds({ verse: { "break-after": "right" } }), [
    "matter-half-title",
  ]);
  assertEquals(isIds({ verse: { "break-before": "right" } }), all);
});

Deno.test("renderSegments: run-on chapters merge into the segment before", () => {
  const doc = parse(SEGMENT_BOOK);
  const segs = renderSegments(doc, {
    elements: { chapter: { "break-before": "auto" } },
  });
  assertEquals(segs.map((s) => s.id), [
    "matter-half-title",
    "matter-copyright",
    "matter-toc",
    "matter-preface", // the body's first chapter runs on too: `.chapter` outranks base.css
    "one",
    "matter-appendix",
    "matter-colophon",
  ]);
  // The part's chapters run on inside the part's own section, no wrapper.
  const part = segs.find((s) => s.id === "one")!;
  assert(!part.html.includes("data-split-from"));
  assertEquals(part.ids, ["one", "thaw", "fnref-n1", "note-n1", "crossing"]);
  assertEquals(joined(segs), joined(renderSegments(doc)));
  // Everything run on: the book is one segment, render() itself.
  const one = renderSegments(doc, {
    elements: {
      chapter: { "break-before": "avoid" },
      part: { "break-before": "auto" },
      matter: { "break-before": "auto" },
    },
  });
  assertEquals(one.length, 1);
  assertEquals(one[0]!.html, renderLined(doc));
});
