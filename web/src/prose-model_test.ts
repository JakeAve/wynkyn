import { assertEquals } from "@std/assert";
import { chapterAt, proseLines, wordCount } from "./prose-model.ts";

const folded = (lines: string[], cursor: number) =>
  proseLines(lines, cursor).flatMap((l, i) => l.fold ? [i] : []);

// Ported from hiddenLines: every paragraph but the cursor's folds its markup,
// now a structural line (into its rubric) and a lone sentinel (into its
// stand-in) too.
Deno.test("proseLines: folds markup everywhere but the cursor's paragraph", () => {
  const lines = [
    "{chapter: one}", // 0
    "{title}", // 1
    "Marley's Ghost",
    "",
    "{illustration: a}", // 4 alone: folds into its stand-in
    "",
    "{quote}", // 6
    "Words.",
    "{/quote}", // 8
    "",
    "{dropcap}", // 10
    "MARLEY was dead.",
  ];
  assertEquals(folded(lines, 11), [0, 1, 4, 6, 8]);
  assertEquals(folded(lines, 2), [4, 6, 8, 10]);
  // On a blank line nothing is revealed.
  assertEquals(folded(lines, 3), [0, 1, 4, 6, 8, 10]);
});

Deno.test("proseLines: a chapter with a title", () => {
  const lines = [
    "{chapter: stave-1}",
    "{title}",
    "Marley's Ghost",
    "",
    "Text.",
  ];
  assertEquals(proseLines(lines, 4), [
    {
      fold: true,
      rubric: { label: "Chapter", slug: "stave-1", rule: true },
    },
    { fold: true },
    { fold: false, rubric: { label: "Title" }, kind: "title" },
    { fold: false },
    { fold: false },
  ]);
  // The cursor on the title reveals the chapter's markup; rubrics stay.
  const at = proseLines(lines, 2);
  assertEquals(at.map((l) => l.fold), [false, false, false, false, false]);
  assertEquals(at[0]!.rubric?.label, "Chapter");
  assertEquals(at[2]!.rubric?.label, "Title");
});

Deno.test("proseLines: matter, subtitle and heading", () => {
  const p = proseLines(
    [
      "{matter: preface}",
      "{subtitle}",
      "Being a note",
      "",
      "{heading}",
      "A",
      "B",
    ],
    -1,
  );
  assertEquals(p[0]!.rubric, { label: "Matter", slug: "preface", rule: true });
  assertEquals([p[2]!.kind, p[2]!.rubric?.label], ["subtitle", "Subtitle"]);
  assertEquals([p[5]!.kind, p[6]!.kind], ["title", "title"]);
  assertEquals(p[5]!.rubric?.label, "Heading");
});

Deno.test("proseLines: a quote spanning paragraphs", () => {
  const lines = ["{quote}", "One.", "", "Two.", "{/quote}", "", "After."];
  const p = proseLines(lines, 6);
  assertEquals(p.map((l) => l.kind), [
    undefined,
    "block",
    undefined,
    "block",
    undefined,
    undefined,
    undefined,
  ]);
  assertEquals(p[1]!.rubric, { label: "Quote" });
  assertEquals(folded(lines, 6), [0, 4]);
  // The cursor in the second paragraph reveals only that paragraph's tag.
  assertEquals(folded(lines, 3), [0]);
  assertEquals(folded(lines, 1), [4]);
});

Deno.test("proseLines: a quote with no closing tag holds one paragraph", () => {
  const p = proseLines(["{epigraph}", "Words.", "{attribution}", "— X"], -1);
  assertEquals(p.map((l) => l.kind), [
    undefined,
    "block",
    undefined,
    undefined,
  ]);
  assertEquals(p[3]!.rubric?.label, "Attribution");
});

Deno.test("proseLines: {break} alone", () => {
  const lines = ["Before.", "", "{break: years}", "", "After."];
  assertEquals(proseLines(lines, 0)[2], {
    fold: true,
    standIn: "break",
    slug: "years",
    rubric: { label: "Break", slug: "years" },
  });
  assertEquals(proseLines(lines, 2)[2]!.fold, false);
});

Deno.test("proseLines: {illustration} with and without a caption", () => {
  const lines = [
    "{illustration: door | placement: inline}",
    "The door.",
    "",
    "{illustration: map}",
  ];
  const p = proseLines(lines, -1);
  assertEquals(p[0], {
    fold: true,
    standIn: "illustration",
    slug: "door",
    rubric: { label: "Illustration", slug: "door" },
  });
  assertEquals(p[1], { fold: false, kind: "caption" });
  assertEquals(p[3], {
    fold: true,
    standIn: "illustration",
    slug: "map",
    rubric: { label: "Illustration", slug: "map" },
  });
  assertEquals(folded(lines, 1), [3]);
  assertEquals(folded(lines, 3), [0]);
});

Deno.test("proseLines: an illustration whose file is missing stays plain", () => {
  const lines = [
    "{illustration: door}",
    "The door.",
    "",
    "{illustration: map}",
  ];
  const p = proseLines(lines, -1, (slug) => slug === "map");
  assertEquals(p.slice(0, 2), [{ fold: false }, { fold: false }]);
  assertEquals(p[3]!.standIn, "illustration");
});

Deno.test("proseLines: plates and drop-cap images stay plain markup", () => {
  const lines = [
    "{illustration: door | placement: full-page}",
    "The door.",
    "",
    "{dropcap | image: initial-t}",
    "The morning.",
  ];
  assertEquals(proseLines(lines, -1), lines.map(() => ({ fold: false })));
});

Deno.test("proseLines: {is: aside} is labelled by its class", () => {
  const lines = ["{is: aside}", "A word.", "{/is: aside}"];
  const p = proseLines(lines, -1);
  assertEquals(p[1], { fold: false, rubric: { label: "aside" } });
  assertEquals(folded(lines, -1), [0, 2]);
  assertEquals(folded(lines, 1), []);
});

Deno.test("proseLines: {only} names its editions", () => {
  const lines = [
    "{only: a b}",
    "Pocket text.",
    "{/only}",
    "",
    "{only: pocket | default}",
    "X",
    "{/only}",
  ];
  const p = proseLines(lines, -1);
  assertEquals(p[1]!.rubric, { label: "Only", slug: "a · b" });
  assertEquals(p[5]!.rubric, { label: "Only", slug: "pocket · default" });
  assertEquals(folded(lines, -1), [0, 2, 4, 6]);
  assertEquals(folded(lines, 1), [4, 6]);
});

Deno.test("proseLines: an outer block's rubric keeps the text; the inner tag carries its own", () => {
  const p = proseLines([
    "{verses: g}",
    "{dropcap}",
    "In the beginning.",
    "{/verses}",
  ], -1);
  assertEquals(p[2]!.rubric, { label: "Verses", slug: "g" });
  assertEquals(p[1]!.rubric, { label: "Drop cap" });
});

Deno.test("proseLines: %% lines fold into notes", () => {
  const lines = [
    "%% ─────────", // rule: dropped
    "%% BODY",
    "%% ─────────",
    "",
    "{chapter: one}",
    "",
    "First line.",
    "%% check: a guess.",
    "",
    "%% check: no author.",
    "{author}",
    "%% fill in",
  ];
  const p = proseLines(lines, -1);
  assertEquals(p[4]!.note, "BODY"); // nothing above: the next shown line
  assertEquals(p[6]!.note, "check: a guess.");
  // A note first in its paragraph goes forward; {author} has no text, so it
  // carries its rubric and keeps a row for the notes.
  assertEquals(p[10], {
    fold: true,
    rubric: { label: "Author" },
    note: "check: no author.\nfill in",
  });
  assertEquals(p.filter((l) => l.note).length, 3);
  // At the cursor the %% line shows in place and is no note.
  const at = proseLines(lines, 7);
  assertEquals([at[7]!.fold, at[6]!.note], [false, undefined]);
});

Deno.test("wordCount: skips sentinels, comments and tags", () => {
  assertEquals(wordCount([]), 0);
  assertEquals(
    wordCount([
      "{chapter: one}", // sentinel
      "{title}",
      "Marley's Ghost", // 2
      "",
      "%% a note that is not counted", // comment
      "One {em}two{/em} thr{em}ee{/em} four.{footnote: n1}", // 4: tags cut
      "Escaped \\{em} and back — here", // 5: escaped text counts, a dash is no word
      "{only: pocket}",
      "Only in the pocket.", // 4: an {only} span's words count
      "{/only}",
    ]),
    2 + 4 + 5 + 4,
  );
  // a footnote or ref inside an em is still cut
  assertEquals(wordCount(["{em}a fine day{footnote: n1}{/em} ok"]), 4);
  assertEquals(wordCount(["{em}see {ref: fig}{/em}"]), 1);
});

Deno.test("chapterAt: title, slug fallback, before any chapter", () => {
  const lines = [
    "Front words.", // 1
    "{chapter: one}", // 2
    "{title}", // 3
    "Marley's {em}Ghost{/em}", // 4
    "",
    "Text.", // 6
    "{chapter: two}", // 7
    "Text.", // 8
    "{part: p}", // 9
    "x", // 10
  ];
  assertEquals(chapterAt(lines, 1), null);
  assertEquals(chapterAt(lines, 2), { slug: "one", title: "Marley's Ghost" });
  assertEquals(chapterAt(lines, 6), { slug: "one", title: "Marley's Ghost" });
  assertEquals(chapterAt(lines, 8), { slug: "two", title: null });
  assertEquals(chapterAt(lines, 10), null);
});

Deno.test("proseLines: `line` reveals that line alone", () => {
  const lines = ["{chapter: one}", "{title}", "Marley's Ghost"];
  const p = proseLines(lines, -1, undefined, 0);
  assertEquals(p.map((l) => l.fold), [false, true, false]);
});
