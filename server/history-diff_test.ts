// server/history-diff_test.ts
import { assert, assertEquals } from "@std/assert";
import { diffMetadata, diffText } from "./history-diff.ts";

const BOOK = `{matter: title-page}

{title} A Book

{chapter: one}

First paragraph here.

Second paragraph, the old one.

{chapter: two}

Third paragraph.
`;

Deno.test("diffText: unchanged text has no diffs", () => {
  assertEquals(diffText(BOOK, BOOK), []);
});

Deno.test("diffText: one-word change is word-level, grouped by chapter", () => {
  const after = BOOK.replace("the old one", "the new one");
  assertEquals(diffText(BOOK, after), [{
    chapter: "one",
    paras: [{
      segs: [
        { t: "Second paragraph, the ", op: "same" },
        { t: "old", op: "del" },
        { t: "new", op: "ins" },
        { t: " one.", op: "same" },
      ],
    }],
  }]);
});

Deno.test("diffText: deleted paragraph is one del segment", () => {
  const after = BOOK.replace("First paragraph here.\n\n", "");
  assertEquals(diffText(BOOK, after), [{
    chapter: "one",
    paras: [{ segs: [{ t: "First paragraph here.", op: "del" }] }],
  }]);
});

Deno.test("diffText: inserted paragraph is one ins segment, front matter named", () => {
  const before = "Opening words.\n\n" + BOOK;
  const after = BOOK.replace(
    "Third paragraph.",
    "Third paragraph.\n\nA new one.",
  );
  assertEquals(diffText(before, after), [
    {
      chapter: "Front matter",
      paras: [{ segs: [{ t: "Opening words.", op: "del" }] }],
    },
    { chapter: "two", paras: [{ segs: [{ t: "A new one.", op: "ins" }] }] },
  ]);
});

Deno.test("diffText: segments reproduce both sides", () => {
  const after = BOOK.replace(
    "Third paragraph.",
    "Third  paragraph,\nrewritten.",
  );
  const [d] = diffText(BOOK, after);
  const segs = d!.paras[0]!.segs;
  const side = (skip: string) =>
    segs.filter((s) => s.op !== skip).map((s) => s.t).join("");
  assertEquals(side("ins"), "Third paragraph.");
  assertEquals(side("del"), "Third  paragraph,\nrewritten.");
});

Deno.test("diffText: a 3000-paragraph manuscript diffs fast", () => {
  const paras = Array.from(
    { length: 3000 },
    (_, i) =>
      `{chapter: c${i}}\n\nParagraph ${i} with some words to make it about a hundred bytes long, give or take a few.`,
  );
  const before = paras.join("\n\n");
  const after = before.replace("Paragraph 1500 with", "Paragraph 1500 without");
  const t = performance.now();
  const d = diffText(before, after);
  assert(performance.now() - t < 1000);
  assertEquals(d.map((c) => c.chapter), ["c1500"]);
});

Deno.test("diffMetadata: font-size change under elements", () => {
  assertEquals(
    diffMetadata(
      { elements: { "chapter-title": { "font-size": "18pt" } } },
      { elements: { "chapter-title": { "font-size": "20pt" } } },
    ),
    [{
      path: ["elements", "chapter-title", "font-size"],
      from: "18pt",
      to: "20pt",
    }],
  );
});

Deno.test("diffMetadata: added and removed leaves, null sides", () => {
  assertEquals(
    diffMetadata({ fonts: { body: "EB Garamond" } }, { name: "Pocket" }),
    [
      { path: ["fonts", "body"], from: "EB Garamond", to: undefined },
      { path: ["name"], from: undefined, to: "Pocket" },
    ],
  );
  assertEquals(diffMetadata(null, { language: "es" }), [
    { path: ["language"], from: undefined, to: "es" },
  ]);
  assertEquals(diffMetadata(null, null), []);
});
