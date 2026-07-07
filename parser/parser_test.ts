import { assert, assertEquals } from "jsr:@std/assert";
import { parse } from "./parser.ts";
import type { Chapter, Paragraph, Part } from "./types.ts";
import type { Break, Component, DropcapParagraph, Heading, Illustration, Inline, Note } from "./types.ts";

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
    p1.children.filter((c) => c.kind === "chapter").map((c) => (c as Chapter).slug),
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
  assertEquals(text(doc.frontMatter[0]!.children[0] as Paragraph), "For my father, who kept the trees.");
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
  assertEquals(text((doc.body[0] as Chapter).children[0] as Paragraph), "%% not a comment");
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
  assertEquals(text((doc.body[0] as Chapter).children[0] as Paragraph), "Prose.");
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
  assertEquals(kids.map((k) => k.name), ["title", "subtitle", "author", "author", "year"]);
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
  const doc = parse("{chapter: thaw}\n{title}\nThe First Thaw\n\nProse begins.");
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
  const doc = parse("{chapter: thaw}\n{dropcap | image: initial-T}\nThe morning came slowly.");
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
  assertEquals([h1.level, h1.slug, inlineText(h1.inlines)], [1, "spring-1943", "Spring, 1943"]);
  assertEquals([h2.level, h2.slug], [2, undefined]);
});

Deno.test("break: bare and slugged (§3.5.6)", () => {
  const doc = parse("{chapter: one}\nBefore.\n\n{break}\n\nMiddle.\n\n{break: passage-of-years}\n\nAfter.");
  const kinds = (doc.body[0] as Chapter).children.map((c) => c.kind);
  assertEquals(kinds, ["paragraph", "break", "paragraph", "break", "paragraph"]);
  const b2 = (doc.body[0] as Chapter).children[3] as Break;
  assertEquals(b2.slug, "passage-of-years");
});

Deno.test("illustration with placement and caption (§3.6.1)", () => {
  const doc = parse("{chapter: one}\n{illustration: orchard-1943 | placement: full-page}\nThe Orchard, circa 1943");
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
  const doc = parse("{chapter: one}\n{illustration: x | placement: sideways}\nCap");
  assert(doc.diagnostics.some((d) => d.message.includes("placement")));
});

Deno.test("note content node (§3.6.8)", () => {
  const doc = parse("{chapter: one}\nThe harvest was poor.{footnote: harvest-1943}\n\n{note: harvest-1943}\nRegional records show a 40% reduction.");
  const ch = doc.body[0] as Chapter;
  const note = ch.children[1] as Note;
  assertEquals(note.kind, "note");
  assertEquals(note.slug, "harvest-1943");
  assertEquals(inlineText(note.inlines), "Regional records show a 40% reduction.");
});

Deno.test("attribution with nothing to bind to: diagnostic, kept as component", () => {
  const doc = parse("{chapter: one}\n{attribution}\n— Nobody");
  const ch = doc.body[0] as Chapter;
  assertEquals((ch.children[0] as Component).name, "attribution");
  assert(doc.diagnostics.some((d) => d.message.includes("attribution")));
});
