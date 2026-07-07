import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { parse } from "../parser/parser.ts";
import { formatNumber, render } from "./render.ts";

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
  const html = render(parse("{matter: half-title}\n{title}\nCommon Sense\n{chapter: one}\nProse.\n{matter: colophon}\nSet by hand."));
  assertStringIncludes(html, '<article class="bml">');
  assertStringIncludes(html, '<div class="zone zone-front">');
  assertStringIncludes(html, '<section class="matter matter-half-title" id="matter-half-title">');
  assertStringIncludes(html, '<div class="zone zone-body">');
  assertStringIncludes(html, '<div class="zone zone-back">');
});

Deno.test("chapter: id from slug, numbered title per opts.numbering", () => {
  const html = render(parse("{chapter: thaw}\n{title}\nThe First Thaw\n\nProse."), {
    numbering: { chapters: { style: "roman-upper", show: true, prefix: "", suffix: "." } },
  });
  assertStringIncludes(html, '<section class="chapter" id="thaw">');
  assertStringIncludes(html, '<div class="number">I.</div>');
  assertStringIncludes(html, '<h1 class="title">The First Thaw</h1>');
});

Deno.test("chapter numbers continue across parts; parts numbered separately", () => {
  const html = render(
    parse("{part: one}\n{chapter: a}\nx\n{chapter: b}\nx\n{part: two}\n{chapter: c}\nx"),
    { numbering: { chapters: { style: "arabic", show: true }, parts: { style: "roman-upper", show: true, prefix: "Part " } } },
  );
  assertStringIncludes(html, '<section class="part" id="one">');
  assertStringIncludes(html, '<div class="number">Part I</div>');
  assertStringIncludes(html, '<div class="number">Part II</div>');
  // chapter c is the third chapter overall
  const cIdx = html.indexOf('id="c"');
  assertStringIncludes(html.slice(cIdx, cIdx + 200), '<div class="number">3</div>');
});

Deno.test("numbering show:false suppresses the number div", () => {
  const html = render(parse("{chapter: a}\n{title}\nT\n\nx"), {
    numbering: { chapters: { style: "arabic", show: false } },
  });
  assert(!html.includes('class="number"'));
});

Deno.test("inline rendering: em, hard break, HTML escaping", () => {
  const html = render(parse("{chapter: a}\nShe saw the {em}Queen Mary{/em} & waved\\\ntwice."));
  assertStringIncludes(html, "<em>Queen Mary</em> &amp; waved<br>twice.");
});

Deno.test("dropcap wraps first letter in a span", () => {
  const html = render(parse("{chapter: a}\n{dropcap}\nThe morning came."));
  assertStringIncludes(html, '<p class="has-dropcap"><span class="dropcap">T</span>he morning came.</p>');
});

Deno.test("dropcap correctly splits when the first inline is emphasized", () => {
  const html = render(parse("{chapter: a}\n{dropcap}\n{em}The{/em} morning came."));
  assertStringIncludes(html, '<p class="has-dropcap"><span class="dropcap">T</span><em>he</em> morning came.</p>');
});

Deno.test("dropcap correctly escapes a first character that needs HTML escaping", () => {
  const html = render(parse("{chapter: a}\n{dropcap}\n& so it began."));
  assertStringIncludes(html, '<p class="has-dropcap"><span class="dropcap">&amp;</span> so it began.</p>');
});

Deno.test("verses render numbers from start (§3.5.7)", () => {
  const html = render(parse("{chapter: a}\n{verses: gen-1 | start: 3}\nAnd God said.\n{/verses}"));
  assertStringIncludes(html, '<div class="verses" id="gen-1">');
  assertStringIncludes(html, '<span class="number">3</span>');
});

Deno.test("endnotes collect at the end of the structural block", () => {
  const html = render(
    parse("{chapter: a}\nPoor harvest.{footnote: h43}\n\n{note: h43}\nRecords show 40%."),
    { notes: { placement: "endnote" } },
  );
  assertStringIncludes(html, '<sup class="footnote-anchor" id="fnref-h43"><a href="#note-h43">1</a></sup>');
  assertStringIncludes(html, '<aside class="notes">');
  assertStringIncludes(html, '<div class="note" id="note-h43">');
});

Deno.test("footnote placement inlines the note at the anchor", () => {
  const html = render(
    parse("{chapter: a}\nPoor harvest.{footnote: h43}\n\n{note: h43}\nRecords show 40%."),
    { notes: { placement: "footnote" } },
  );
  assertStringIncludes(html, '<span class="note" id="note-h43">Records show 40%.</span>');
  assert(!html.includes("<aside"));
});

Deno.test("ref renders as an empty anchor for target-counter (§3.8)", () => {
  const html = render(parse("{chapter: thaw}\nx\n{chapter: b}\nAs discussed in {ref: thaw}, it turned."));
  assertStringIncludes(html, '<a class="ref" href="#thaw"></a>');
});

Deno.test("toc: generated from structure when only a title is present", () => {
  const html = render(parse([
    "{matter: toc}",
    "{title}",
    "Contents",
    "{part: one}",
    "{title}",
    "Part One",
    "{chapter: thaw}",
    "{title}",
    "The First Thaw",
    "",
    "x",
    "{matter: appendix}",
    "{title}",
    "Family Tree",
  ].join("\n")));
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, '<a class="entry" href="#thaw">The First Thaw</a>');
  assertStringIncludes(html, '<a class="entry" href="#one">Part One</a>');
  assertStringIncludes(html, '<a class="entry" href="#matter-appendix">Family Tree</a>');
});

Deno.test("toc: manual content renders verbatim, no generated nav", () => {
  const html = render(parse("{matter: toc}\nChapter One .... 1\n{chapter: a}\nx"));
  assert(!html.includes('<nav class="toc">'));
  assertStringIncludes(html, "Chapter One .... 1");
});

Deno.test("illustration: resolved image vs visible placeholder (§4.11)", () => {
  const src = "{chapter: a}\n{illustration: orchard | placement: full-page}\nThe Orchard";
  const withImg = render(parse(src), { images: { orchard: "images/orchard.png" } });
  assertStringIncludes(withImg, '<figure class="illustration placement-full-page" id="orchard">');
  assertStringIncludes(withImg, '<img src="images/orchard.png" alt="The Orchard">');
  assertStringIncludes(withImg, '<figcaption class="caption">The Orchard</figcaption>');
  const without = render(parse(src));
  assertStringIncludes(without, '<div class="illustration-placeholder">[illustration: orchard]</div>');
});

Deno.test("columns: flow uses column-count, parallel uses one div per column", () => {
  const flow = render(parse("{chapter: a}\n{columns: 2}\nProse here.\n{/columns}"));
  assertStringIncludes(flow, '<div class="columns columns-flow" style="column-count: 2">');
  const parallel = render(parse("{chapter: a}\n{columns: 2}\nEnglish.\n{col}\nGerman.\n{/columns}"));
  assertStringIncludes(parallel, '<div class="columns columns-parallel" style="grid-template-columns: repeat(2, 1fr)">');
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
  assertStringIncludes(html, '<p class="stanza">The apples fall<br>in rows.</p>');
  assertStringIncludes(html, '<aside class="sidebar">');
  assertStringIncludes(html, '<aside class="pullquote">');
  assertStringIncludes(html, '<div class="is-telegram">');
  assertStringIncludes(html, "<ul><li>one</li><li>two</li></ul>");
  assertStringIncludes(html, '<div class="break break-passage-of-years"></div>');
});
