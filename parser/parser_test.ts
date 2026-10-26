import { assert, assertEquals } from "@std/assert";
import { checkOnlySpans, parse } from "./parser.ts";
import type { Chapter, Paragraph, Part } from "./types.ts";
import type {
  Break,
  Component,
  DropcapParagraph,
  Heading,
  Illustration,
  Inline,
  Note,
} from "./types.ts";
import type { Epigraph, IsBlock, Poem, Quote, Sidebar } from "./types.ts";
import type { Columns, List, Verses } from "./types.ts";

function inlineText(inlines: Inline[]): string {
  return inlines.map((i) => (i.kind === "text" ? i.text : "")).join("");
}

export function text(p: Paragraph): string {
  return p.inlines.map((i) => (i.kind === "text" ? i.text : "")).join("");
}

Deno.test("three-zone partition (§3.3)", () => {
  const doc = parse([
    "{matter: half-title}",
    "{chapter: one}",
    "Prose.",
    "{matter: appendix | label: A}",
    "{title}",
    "Family Tree",
  ].join("\n"));
  assertEquals(doc.frontMatter.map((m) => m.type), ["half-title"]);
  assertEquals(doc.body.length, 1);
  assertEquals(doc.backMatter.map((m) => m.type), ["appendix"]);
  assertEquals(doc.backMatter[0]!.label, "A");
  assertEquals(doc.diagnostics, []);
});

Deno.test("chapter nests inside part; part closes part (§3.2.3)", () => {
  const doc = parse([
    "{part: frost}",
    "{chapter: thaw}",
    "One.",
    "{chapter: river}",
    "Two.",
    "{part: summer}",
    "{chapter: heat}",
  ].join("\n"));
  assertEquals(doc.body.length, 2);
  const p1 = doc.body[0] as Part;
  assertEquals(
    p1.children.filter((c) => c.kind === "chapter").map((c) =>
      (c as Chapter).slug
    ),
    ["thaw", "river"],
  );
  const p2 = doc.body[1] as Part;
  assertEquals((p2.children[0] as Chapter).slug, "heat");
});

Deno.test("matter closes an open part and chapter (§3.2.3)", () => {
  const doc = parse([
    "{part: frost}",
    "{chapter: thaw}",
    "Body prose.",
    "{matter: colophon}",
    "Colophon prose.",
  ].join("\n"));
  assertEquals(doc.backMatter.length, 1);
  assertEquals(doc.backMatter[0]!.children.length, 1); // prose went to the matter, not the chapter
});

Deno.test("prose in a matter block (dedication, §3.4.4)", () => {
  const doc = parse("{matter: dedication}\nFor my father, who kept the trees.");
  assertEquals(
    text(doc.frontMatter[0]!.children[0] as Paragraph),
    "For my father, who kept the trees.",
  );
});

Deno.test("paragraphs split on blank lines; source lines join (§3.2.5)", () => {
  const doc = parse("{chapter: one}\nFirst para\nstill first.\n\nSecond.");
  const ch = doc.body[0] as Chapter;
  assertEquals(ch.children.length, 2);
  assertEquals(text(ch.children[0] as Paragraph), "First para still first.");
});

Deno.test("comments are stripped and do not break a paragraph (§3.2.1)", () => {
  const doc = parse("{chapter: one}\nab\n%% invisible\ncd");
  const ch = doc.body[0] as Chapter;
  assertEquals(ch.children.length, 1);
  assertEquals(text(ch.children[0] as Paragraph), "ab cd");
});

Deno.test("escaped line is prose, not a comment (§3.2.8)", () => {
  const doc = parse("{chapter: one}\n\\%% not a comment");
  assertEquals(
    text((doc.body[0] as Chapter).children[0] as Paragraph),
    "%% not a comment",
  );
});

Deno.test("orphan prose lands in an implicit chapter with a diagnostic", () => {
  const doc = parse("Just typing, no sentinels yet.");
  assertEquals(doc.body.length, 1);
  assertEquals((doc.body[0] as Chapter).slug, "untitled");
  assert(doc.diagnostics.length > 0);
});

Deno.test("part or chapter after back matter: diagnostic, content preserved", () => {
  const doc = parse([
    "{chapter: one}",
    "Body.",
    "{matter: appendix}",
    "{chapter: two}",
    "Late prose.",
  ].join("\n"));
  assertEquals(doc.body.length, 2); // both chapters preserved
  assert(doc.diagnostics.some((d) => d.message.includes("back matter")));
});

Deno.test("CRLF input parses identically", () => {
  const doc = parse("{chapter: one}\r\nProse.\r\n");
  assertEquals(
    text((doc.body[0] as Chapter).children[0] as Paragraph),
    "Prose.",
  );
});

Deno.test("unknown sentinel: diagnostic, no throw", () => {
  const doc = parse("{chapter: one}\n{wibble: x}\nProse.");
  assert(doc.diagnostics.some((d) => d.message.includes("wibble")));
});

Deno.test("title page components, repeated {author} (§3.4.2)", () => {
  const doc = parse([
    "{matter: title-page}",
    "{title}",
    "The Orchard at the End of the Road",
    "{subtitle}",
    "A Novel",
    "{author}",
    "Jane Ellory",
    "{author}",
    "Thomas Vane",
    "{year}",
    "2024",
  ].join("\n"));
  const kids = doc.frontMatter[0]!.children as Component[];
  assertEquals(kids.map((k) => k.name), [
    "title",
    "subtitle",
    "author",
    "author",
    "year",
  ]);
  assertEquals(inlineText(kids[2]!.inlines), "Jane Ellory");
  assertEquals(doc.diagnostics, []);
});

Deno.test("component content may wrap lines until blank/sentinel ({rights}, §3.2.3)", () => {
  const doc = parse([
    "{matter: copyright}",
    "{rights}",
    "All rights reserved. No part of this publication may be reproduced",
    "without prior written permission of the publisher.",
    "{isbn}",
    "978-0-000-00000-0",
  ].join("\n"));
  const rights = doc.frontMatter[0]!.children[0] as Component;
  assertEquals(rights.name, "rights");
  assertEquals(
    inlineText(rights.inlines),
    "All rights reserved. No part of this publication may be reproduced without prior written permission of the publisher.",
  );
});

Deno.test("chapter title lives as a component child of the chapter (§3.5.2)", () => {
  const doc = parse(
    "{chapter: thaw}\n{title}\nThe First Thaw\n\nProse begins.",
  );
  const ch = doc.body[0] as Chapter;
  assertEquals(ch.children.length, 2);
  assertEquals((ch.children[0] as Component).name, "title");
  assertEquals(ch.children[1]!.kind, "paragraph");
});

Deno.test("component followed by blank line finalizes empty, no crash", () => {
  const doc = parse("{chapter: one}\n{title}\n\nProse.");
  const t = (doc.body[0] as Chapter).children[0] as Component;
  assertEquals(t.inlines, []);
});

Deno.test("dropcap wraps its following paragraph (§3.5.4)", () => {
  const doc = parse("{chapter: thaw}\n{dropcap}\nThe morning came slowly.");
  const d = (doc.body[0] as Chapter).children[0] as DropcapParagraph;
  assertEquals(d.kind, "dropcap");
  assertEquals(inlineText(d.inlines), "The morning came slowly.");
  assertEquals(d.image, undefined);
});

Deno.test("dropcap with image param (§3.5.4)", () => {
  const doc = parse(
    "{chapter: thaw}\n{dropcap | image: initial-T}\nThe morning came slowly.",
  );
  const d = (doc.body[0] as Chapter).children[0] as DropcapParagraph;
  assertEquals(d.image, "initial-T");
});

Deno.test("dropcap with no following paragraph: diagnostic", () => {
  const doc = parse("{chapter: thaw}\n{dropcap}\n\nLater prose.");
  assert(doc.diagnostics.some((d) => d.message.includes("dropcap")));
});

Deno.test("heading and subheading levels, optional slug (§3.5.3)", () => {
  const doc = parse([
    "{chapter: letters}",
    "{heading: spring-1943}",
    "Spring, 1943",
    "",
    "{subheading}",
    "The First Letter",
  ].join("\n"));
  const ch = doc.body[0] as Chapter;
  const h1 = ch.children[0] as Heading;
  const h2 = ch.children[1] as Heading;
  assertEquals([h1.level, h1.slug, inlineText(h1.inlines)], [
    1,
    "spring-1943",
    "Spring, 1943",
  ]);
  assertEquals([h2.level, h2.slug], [2, undefined]);
});

Deno.test("break: bare and slugged (§3.5.6)", () => {
  const doc = parse(
    "{chapter: one}\nBefore.\n\n{break}\n\nMiddle.\n\n{break: passage-of-years}\n\nAfter.",
  );
  const kinds = (doc.body[0] as Chapter).children.map((c) => c.kind);
  assertEquals(kinds, [
    "paragraph",
    "break",
    "paragraph",
    "break",
    "paragraph",
  ]);
  const b2 = (doc.body[0] as Chapter).children[3] as Break;
  assertEquals(b2.slug, "passage-of-years");
});

Deno.test("illustration with placement and caption (§3.6.1)", () => {
  const doc = parse(
    "{chapter: one}\n{illustration: orchard-1943 | placement: full-page}\nThe Orchard, circa 1943",
  );
  const il = (doc.body[0] as Chapter).children[0] as Illustration;
  assertEquals(il.slug, "orchard-1943");
  assertEquals(il.placement, "full-page");
  assertEquals(inlineText(il.caption!), "The Orchard, circa 1943");
});

Deno.test("illustration without placement or caption (§3.6.1)", () => {
  const doc = parse("{chapter: one}\n{illustration: orchard-1943}\n\nProse.");
  const il = (doc.body[0] as Chapter).children[0] as Illustration;
  assertEquals(il.placement, undefined);
  assertEquals(il.caption, undefined);
  assertEquals(doc.diagnostics, []);
});

Deno.test("invalid illustration placement: diagnostic", () => {
  const doc = parse(
    "{chapter: one}\n{illustration: x | placement: sideways}\nCap",
  );
  assert(doc.diagnostics.some((d) => d.message.includes("placement")));
});

Deno.test("note content node (§3.6.8)", () => {
  const doc = parse(
    "{chapter: one}\nThe harvest was poor.{footnote: harvest-1943}\n\n{note: harvest-1943}\nRegional records show a 40% reduction.",
  );
  const ch = doc.body[0] as Chapter;
  const note = ch.children[1] as Note;
  assertEquals(note.kind, "note");
  assertEquals(note.slug, "harvest-1943");
  assertEquals(
    inlineText(note.inlines),
    "Regional records show a 40% reduction.",
  );
});

Deno.test("attribution with nothing to bind to: diagnostic, kept as component", () => {
  const doc = parse("{chapter: one}\n{attribution}\n— Nobody");
  const ch = doc.body[0] as Chapter;
  assertEquals((ch.children[0] as Component).name, "attribution");
  assert(doc.diagnostics.some((d) => d.message.includes("attribution")));
});

Deno.test("single-paragraph sidebar closes implicitly (§3.6.2)", () => {
  const doc = parse(
    "{chapter: one}\n{sidebar}\nA brief aside.\n\nBack to prose.",
  );
  const ch = doc.body[0] as Chapter;
  const sb = ch.children[0] as Sidebar;
  assertEquals(sb.kind, "sidebar");
  assertEquals(sb.children.length, 1);
  assertEquals(ch.children[1]!.kind, "paragraph"); // "Back to prose." is outside
  assertEquals(doc.diagnostics, []);
});

Deno.test("explicit sidebar spans multiple paragraphs (§3.6.2)", () => {
  const doc = parse(
    "{chapter: one}\n{sidebar}\nFirst.\n\nSecond.\n{/sidebar}\n\nOutside.",
  );
  const ch = doc.body[0] as Chapter;
  const sb = ch.children[0] as Sidebar;
  assertEquals(sb.children.length, 2);
  assertEquals(ch.children.length, 2);
});

Deno.test("unclosed block: content after first paragraph falls outside (§3.2.3)", () => {
  const doc = parse("{chapter: one}\n{sidebar}\nInside.\n\nOutside now.");
  const ch = doc.body[0] as Chapter;
  assertEquals((ch.children[0] as Sidebar).children.length, 1);
  assertEquals(ch.children[1]!.kind, "paragraph");
  assertEquals(doc.diagnostics, []); // a forgotten close tag is not an error
});

Deno.test("implicit block ends at the next sentinel, even with no content", () => {
  const doc = parse("{chapter: one}\n{sidebar}\n{break}\nProse.");
  const ch = doc.body[0] as Chapter;
  assertEquals(ch.children.map((c) => c.kind), [
    "sidebar",
    "break",
    "paragraph",
  ]);
  assertEquals((ch.children[0] as Sidebar).children.length, 0);
});

Deno.test("epigraph with attribution binding (§3.5.5)", () => {
  const doc = parse([
    "{chapter: river}",
    "{epigraph}",
    "The water does not ask where it is going.",
    "{attribution}",
    "— Old Voronin proverb",
  ].join("\n"));
  const ep = (doc.body[0] as Chapter).children[0] as Epigraph;
  assertEquals(ep.kind, "epigraph");
  assertEquals(ep.children.length, 1);
  assertEquals(inlineText(ep.attribution!.inlines), "— Old Voronin proverb");
  assertEquals(doc.diagnostics, []);
});

Deno.test("multi-paragraph quote, attribution after the close (§3.6.4)", () => {
  const doc = parse([
    "{chapter: one}",
    "{quote}",
    "First paragraph of extract.",
    "",
    "Second paragraph.",
    "{/quote}",
    "{attribution}",
    "— Declaration of Independence",
  ].join("\n"));
  const q = (doc.body[0] as Chapter).children[0] as Quote;
  assertEquals(q.children.length, 2);
  assertEquals(
    inlineText(q.attribution!.inlines),
    "— Declaration of Independence",
  );
});

Deno.test("poem: paragraphs are stanzas, hard breaks are lines, attribution binds (§3.5.8)", () => {
  const doc = parse([
    "{chapter: one}",
    "{poem}",
    "The apples fall\\",
    "in ordered rows.",
    "",
    "The winter comes\\",
    "to count them all.",
    "{/poem}",
    "{attribution}",
    "— from Anna's notebook",
  ].join("\n"));
  const poem = (doc.body[0] as Chapter).children[0] as Poem;
  assertEquals(poem.stanzas.length, 2);
  assert(poem.stanzas[0]!.inlines.some((i) => i.kind === "linebreak"));
  assertEquals(inlineText(poem.attribution!.inlines), "— from Anna's notebook");
});

Deno.test("component sentinels are not allowed inside a poem: diagnostic", () => {
  const doc = parse(
    "{chapter: one}\n{poem}\nStanza.\n\n{title}\nNope\n{/poem}",
  );
  assert(doc.diagnostics.some((d) => d.message.includes("poem")));
});

Deno.test("pullquote (§3.6.3)", () => {
  const doc = parse(
    "{chapter: one}\n{pullquote}\nThe orchard remembers what the house has forgotten.",
  );
  assertEquals((doc.body[0] as Chapter).children[0]!.kind, "pullquote");
});

Deno.test("is block: explicit close names its class, other sentinels nest inside (§3.6.6)", () => {
  const doc = parse([
    "{chapter: one}",
    "{is: telegram}",
    "{dropcap}",
    "ARRIVED SAFELY STOP",
    "{/is: telegram}",
  ].join("\n"));
  const is = (doc.body[0] as Chapter).children[0] as IsBlock;
  assertEquals(is.className, "telegram");
  assertEquals(is.children[0]!.kind, "dropcap");
  assertEquals(doc.diagnostics, []);
});

Deno.test("is blocks of different classes nest (§3.2.3 rule 2)", () => {
  const doc = parse([
    "{chapter: one}",
    "{is: letter}",
    "Dear friend,",
    "",
    "{is: postscript}",
    "P.S. Write soon.",
    "{/is: postscript}",
    "{/is: letter}",
  ].join("\n"));
  const outer = (doc.body[0] as Chapter).children[0] as IsBlock;
  assertEquals(outer.className, "letter");
  const inner = outer.children[1] as IsBlock;
  assertEquals(inner.className, "postscript");
  assertEquals(doc.diagnostics, []);
});

Deno.test("overlapping blocks: diagnostic and recovery (§3.2.3 rule 1)", () => {
  const doc = parse([
    "{chapter: one}",
    "{sidebar}",
    "{quote}",
    "text",
    "{/sidebar}",
    "{/quote}",
  ].join("\n"));
  assert(doc.diagnostics.length > 0); // LIFO violation reported, parse continues
});

Deno.test("structural sentinel force-closes open blocks (§3.2.3 rule 3)", () => {
  // The {/quote} exists but a {chapter:} intervenes, so lookahead resolves the
  // quote as implicit; the late {/quote} is diagnosed as stray. Either way the
  // chapter's prose must land in the chapter, never the quote.
  const doc = parse([
    "{chapter: one}",
    "{quote}",
    "Inside quote.",
    "",
    "{chapter: two}",
    "New chapter prose.",
    "{/quote}",
  ].join("\n"));
  assertEquals(doc.body.length, 2);
  const ch2 = doc.body[1] as Chapter;
  assertEquals(ch2.children[0]!.kind, "paragraph"); // prose went to the chapter, not the quote
});

Deno.test("verses: one verse per paragraph, default start 1 (§3.5.7)", () => {
  const doc = parse([
    "{chapter: one}",
    "{verses: genesis-1}",
    "In the beginning God created the heaven and the earth.",
    "",
    "And the earth was without form, and void.",
    "",
    "And God said, Let there be light.",
    "{/verses}",
  ].join("\n"));
  const v = (doc.body[0] as Chapter).children[0] as Verses;
  assertEquals(v.slug, "genesis-1");
  assertEquals(v.start, 1);
  assertEquals(v.verses.length, 3);
  assertEquals(doc.diagnostics, []);
});

Deno.test("verses with start param (§3.5.7)", () => {
  const doc = parse(
    "{chapter: one}\n{verses: genesis-1 | start: 3}\nAnd God said.\n{/verses}",
  );
  const v = (doc.body[0] as Chapter).children[0] as Verses;
  assertEquals(v.start, 3);
});

Deno.test("{dropcap} opens a verse; other sentinels still rejected (§3.5.7)", () => {
  const doc = parse([
    "{chapter: one}",
    "{verses: genesis-1}",
    "{dropcap}",
    "In the beginning God created the heaven and the earth.",
    "",
    "And the earth was without form.",
    "{/verses}",
  ].join("\n"));
  const v = (doc.body[0] as Chapter).children[0] as Verses;
  assertEquals(doc.diagnostics, []);
  assertEquals(v.verses.map((p) => p.kind), ["dropcap", "paragraph"]);

  const bad = parse(
    "{chapter: one}\n{verses: genesis-1}\n{heading}\nNope.\n{/verses}",
  );
  assertEquals(bad.diagnostics.length, 1);

  const poem = parse("{chapter: one}\n{poem}\n{dropcap}\nNope.\n{/poem}");
  assertEquals(poem.diagnostics.length, 1);
});

Deno.test("verses nest inside columns (§3.2.3 example)", () => {
  const doc = parse([
    "{chapter: one}",
    "{columns: 2}",
    "{verses: psalm-19}",
    "The heavens declare the glory of God.",
    "{/verses}",
    "{/columns}",
  ].join("\n"));
  const cols = (doc.body[0] as Chapter).children[0] as Columns;
  assertEquals(cols.columns[0]![0]!.kind, "verses");
  assertEquals(doc.diagnostics, []);
});

Deno.test("columns flow mode: no {col}, single stream (§3.6.5)", () => {
  const doc = parse(
    "{chapter: one}\n{columns: 2}\nA long passage of prose.\n{/columns}",
  );
  const cols = (doc.body[0] as Chapter).children[0] as Columns;
  assertEquals(cols.count, 2);
  assertEquals(cols.mode, "flow");
  assertEquals(cols.columns.length, 1);
});

Deno.test("columns parallel mode: {col} divides content (§3.6.5)", () => {
  const doc = parse([
    "{chapter: one}",
    "{columns: 2}",
    "The heavens declare the glory of God;",
    "{col}",
    "Die Himmel erzählen die Ehre Gottes,",
    "{/columns}",
  ].join("\n"));
  const cols = (doc.body[0] as Chapter).children[0] as Columns;
  assertEquals(cols.mode, "parallel");
  assertEquals(cols.columns.length, 2);
  assertEquals(cols.columns[0]!.length, 1);
  assertEquals(cols.columns[1]!.length, 1);
  assertEquals(doc.diagnostics, []);
});

Deno.test("parallel mode divider-count mismatch: diagnostic (§3.6.5)", () => {
  const doc = parse("{chapter: one}\n{columns: 3}\na\n{col}\nb\n{/columns}");
  assert(doc.diagnostics.some((d) => d.message.includes("divider")));
});

Deno.test("{col} outside {columns:}: diagnostic", () => {
  const doc = parse("{chapter: one}\n{col}");
  assert(doc.diagnostics.some((d) => d.message.includes("col")));
});

Deno.test("invalid columns count: diagnostic", () => {
  const doc = parse("{chapter: one}\n{columns: zero}\nx\n{/columns}");
  assert(doc.diagnostics.some((d) => d.message.includes("column")));
});

Deno.test("unordered list (§3.6.7)", () => {
  const doc = parse(
    "{chapter: one}\n- First item\n- Second item\n- Third item",
  );
  const l = (doc.body[0] as Chapter).children[0] as List;
  assertEquals(l.ordered, false);
  assertEquals(l.items.length, 3);
  assertEquals(inlineText(l.items[0]!), "First item");
});

Deno.test("ordered list records its start number (§3.6.7)", () => {
  const doc = parse("{chapter: one}\n4. Step four\n5. Step five");
  const l = (doc.body[0] as Chapter).children[0] as List;
  assertEquals(l.ordered, true);
  assertEquals(l.start, 4);
  assertEquals(inlineText(l.items[1]!), "Step five");
});

Deno.test("escaped leading dash is prose, not a list (§3.2.8)", () => {
  const doc = parse("{chapter: one}\n\\- not a list item");
  const p = (doc.body[0] as Chapter).children[0] as Paragraph;
  assertEquals(p.kind, "paragraph");
  assertEquals(text(p), "- not a list item");
});

Deno.test("mixed prose and dash lines stay one paragraph", () => {
  const doc = parse(
    "{chapter: one}\nShe said\n- or seemed to say -\nnothing at all.",
  );
  assertEquals((doc.body[0] as Chapter).children[0]!.kind, "paragraph");
});

// NOTE: an implicit (never explicitly closed) `{columns:}` block is evicted by
// popImplicitBlocks() at the very next sentinel line it sees — including its own
// {col} divider — before that {col} can flip it into parallel mode (§3.2.3's
// "forgotten close tag" rule applies to {col} just like every other sentinel;
// see "implicit block ends at the next sentinel, even with no content" above).
// So a `columns` block can only ever reach mode "parallel" if it survives long
// enough to see a real {col}, which requires hasExplicitClose() to have found a
// matching {/columns} — and that in turn guarantees the block is removed via
// closeBlock (top-of-stack match or LIFO-mismatch recovery), never via
// popImplicitBlocks or openStructural's force-close. checkColumnsDividers is
// still wired into all four sites for defensive consistency (and in case that
// invariant changes later), but only the two closeBlock paths are reachable
// today. These two tests pin down the actual (verified) behavior instead.
Deno.test("columns divider check does not false-fire via popImplicitBlocks when {col} evicts the implicit block first", () => {
  const doc = parse(
    "{chapter: one}\n{columns: 3}\na\n{col}\nb\n\nOutside now.",
  );
  assert(!doc.diagnostics.some((d) => d.message.includes("divider")));
  assert(
    doc.diagnostics.some((d) =>
      d.message.includes("{col} outside a {columns:} block")
    ),
  );
});

Deno.test("columns divider check does not false-fire via openStructural when the block was already evicted by {col}", () => {
  const doc = parse(
    "{chapter: one}\n{columns: 3}\na\n{col}\nb\n{chapter: two}\nc",
  );
  assert(!doc.diagnostics.some((d) => d.message.includes("divider")));
  assert(
    doc.diagnostics.some((d) =>
      d.message.includes("{col} outside a {columns:} block")
    ),
  );
});

Deno.test("parallel columns divider mismatch is diagnosed when a LIFO close-order violation discards it", () => {
  const doc = parse(
    "{chapter: one}\n{columns: 3}\na\n{col}\nb\n{sidebar}\nc\n{/columns}\n{/sidebar}",
  );
  assert(doc.diagnostics.some((d) => d.message.includes("divider")));
});

Deno.test("diagnostic: a titled matter block without {title} would vanish from the contents (§3.4.7, §3.7)", () => {
  const doc = parse([
    "{matter: introduction}",
    "Introduction",
    "",
    "p",
    "{chapter: one}",
    "",
    "x",
    "{matter: appendix | label: A}",
    "Family Tree",
  ].join("\n"));
  const msgs = doc.diagnostics.map((d) => `${d.line}: ${d.message}`);
  assertEquals(msgs, [
    "1: {matter: introduction} has no {title} — it will not appear in the table of contents",
    "8: {matter: appendix} has no {title} — it will not appear in the table of contents",
  ]);
});

Deno.test("diagnostic: component-built and untitled display pages are exempt", () => {
  const doc = parse([
    "{matter: copyright}",
    "{copyright-line}",
    "Public domain.",
    "{matter: dedication}",
    "For R.",
    "{matter: epigraph}",
    "{epigraph}",
    "A line.",
    "{chapter: one}",
    "",
    "x",
    "{matter: colophon}",
    "{typeface}",
    "Set in Garamond",
  ].join("\n"));
  assertEquals(doc.diagnostics, []);
});

Deno.test("diagnostic: a titled matter block with {title} is clean", () => {
  const doc = parse(
    "{matter: preface}\n{title}\nPreface\n\np\n{chapter: one}\n\nx",
  );
  assertEquals(doc.diagnostics, []);
});

Deno.test("diagnostic: a toc without {title} is reported as a missing heading, not a missing entry", () => {
  const doc = parse(
    "{matter: toc}\n%% auto-generated by renderer\n{chapter: one}\n\nx",
  );
  assertEquals(doc.diagnostics.map((d) => `${d.line}: ${d.message}`), [
    "1: {matter: toc} has no {title} — the contents page will render without a heading",
  ]);
});

const ONLY_SRC = [
  "{chapter: one}", // 1
  "Shared.", // 2
  "", // 3
  "{only: pocket | large-print}", // 4
  "Gated.", // 5
  "{/only}", // 6
  "After.", // 7
].join("\n");

Deno.test("parse: {only} keeps its blocks for a listed edition and blanks them for others", () => {
  const paras = (edition?: string) =>
    (parse(ONLY_SRC, { edition }).body[0] as Chapter).children.map((p) => [
      text(p as Paragraph),
      p.line,
    ]);
  const all = [["Shared.", 2], ["Gated.", 5], ["After.", 7]];
  assertEquals(paras("large-print"), all);
  assertEquals(paras(), all);
  assertEquals(paras("default"), [["Shared.", 2], ["After.", 7]]);
  const doc = parse(ONLY_SRC, { edition: "default" });
  assertEquals(doc.onlySpans, [{
    line: 4,
    endLine: 6,
    editions: ["pocket", "large-print"],
  }]);
  assertEquals(doc.diagnostics, []);
});

Deno.test("parse: {only} misuse is diagnosed", () => {
  const lines = (src: string[]) =>
    parse(src.join("\n")).diagnostics.map((d) => d.line);
  assertEquals(
    lines([
      "{chapter: a}",
      "{quote}",
      "x",
      "{only: pocket}",
      "y",
      "{/only}",
      "{/quote}",
    ]),
    [4],
  );
  // The reverse: a block opened inside the span is still open at {/only}.
  assertEquals(
    lines([
      "{chapter: a}",
      "{only: pocket}",
      "{quote}",
      "x",
      "{/only}",
      "y",
      "{/quote}",
    ]),
    [5],
  );
  assertEquals(
    lines(["{chapter: a}", "{only: a}", "{only: b}", "{/only}", "{/only}"]),
    [3],
  );
  assertEquals(lines(["{chapter: a}", "{only: pocket}", "x"]), [2]);
  assertEquals(lines(["{chapter: a}", "x", "{/only}"]), [3]);
  assertEquals(lines(["{chapter: a}", "{only}", "x", "{/only}"]), [2]);
});

Deno.test("checkOnlySpans: unknown edition tokens are named on the opening line", () => {
  const { onlySpans } = parse(ONLY_SRC);
  assertEquals(checkOnlySpans(onlySpans, ["default", "pocket"]), [{
    line: 4,
    message: '{only} names unknown edition "large-print"',
  }]);
});

const messages = (src: string) =>
  parse(src).diagnostics.map((d) => `${d.line}: ${d.message}`);

Deno.test("poem and verses hold only stanzas: a dash line stays a stanza, a block is refused", () => {
  const src = [
    "{chapter: a}",
    "{verses: v}",
    "- one",
    "- two",
    "",
    "{quote}",
    "dropped",
    "{/quote}",
    "{/verses}",
  ].join("\n");
  const verses = (parse(src).body[0] as Chapter).children[0]!;
  assert(verses.kind === "verses");
  assertEquals(verses.verses.map((v) => v.kind), ["paragraph"]);
  assertEquals(messages(src), ["6: {quote} is not allowed inside {verses}"]);
});

Deno.test("an {is:} name must be a slug", () => {
  assertEquals(
    messages("{chapter: a}\n{is: Pull quote}\nx\n{/is: Pull quote}"),
    [
      "2: {is: Pull quote} — a class name is lowercase letters, digits and hyphens (§3.2.4)",
    ],
  );
  assertEquals(
    messages("{chapter: a}\n{is: pull-quote-2}\nx\n{/is: pull-quote-2}"),
    [],
  );
});

Deno.test("footnotes and notes pair within their section (§3.6.8)", () => {
  assertEquals(
    messages([
      "{chapter: a}",
      "A{footnote: x} B{footnote: y}",
      "",
      "{note: x}",
      "ex",
      "{chapter: b}",
      "C",
      "",
      "{note: y}",
      "why",
    ].join("\n")),
    [
      "2: {footnote: y} has no {note: y} in this section",
      "9: {note: y} has no {footnote: y} pointing at it",
    ],
  );
});

Deno.test("an unbalanced {em} is diagnosed at its paragraph", () => {
  assertEquals(messages("{chapter: a}\n\nfine\n\nan {em}open\nspan"), [
    "5: {em} is never closed in its paragraph",
  ]);
});
