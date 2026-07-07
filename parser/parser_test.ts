import { assert, assertEquals } from "jsr:@std/assert";
import { parse } from "./parser.ts";
import type { Chapter, Paragraph, Part } from "./types.ts";

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
