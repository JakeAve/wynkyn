import { assert, assertEquals, assertFalse } from "@std/assert";
import type { RunningEntry } from "../../metadata/types.ts";
import {
  bumpLength,
  convertLength,
  emphasisOf,
  formatCssLines,
  headPosition,
  isValidFolios,
  isValidSize,
  makeRunningEntry,
  NUMBERING_STYLES,
  PAGE_NUMBERING_STYLES,
  parseCssLines,
  parseLength,
  presetFor,
  renameColor,
  renameKey,
  runningSummary,
  setHeadPosition,
  setRunningShared,
  splitProps,
  splitRunningEntry,
  stepFor,
} from "./config-data.ts";

Deno.test("presetFor maps stored sizes to presets, custom otherwise", () => {
  assertEquals(presetFor("A5"), "A5");
  assertEquals(presetFor("a5"), "A5"); // named sizes are case-insensitive
  assertEquals(presetFor("5.5in 8.5in"), "5.5in 8.5in");
  assertEquals(presetFor("6.13in 9.21in"), "custom");
  assertEquals(presetFor(undefined), "custom");
});

Deno.test("isValidSize accepts named sizes and length pairs", () => {
  assert(isValidSize("A5"));
  assert(isValidSize("letter"));
  assert(isValidSize("5.5in 8.5in"));
  assert(isValidSize("148mm  210mm")); // extra whitespace ok
  assertFalse(isValidSize(""));
  assertFalse(isValidSize("5.5in")); // one length is not a size
  assertFalse(isValidSize("5.5 8.5")); // unitless
  assertFalse(isValidSize("5.5in 8.5in 3in"));
  assertFalse(isValidSize("tabloid-ish"));
});

Deno.test("isValidFolios accepts positive integers only", () => {
  assert(isValidFolios("1"));
  assert(isValidFolios("12"));
  assertFalse(isValidFolios("0"));
  assertFalse(isValidFolios("-2"));
  assertFalse(isValidFolios("2.5"));
  assertFalse(isValidFolios(""));
  assertFalse(isValidFolios("four"));
});

Deno.test("css lines parse and format round-trip", () => {
  const props = parseCssLines(
    "font-size: 8pt\nfont-style: italic;\n\nnonsense line\n",
  );
  assertEquals(props, { "font-size": "8pt", "font-style": "italic" });
  assertEquals(formatCssLines(props), "font-size: 8pt\nfont-style: italic");
  assertEquals(parseCssLines(""), {});
  // values containing colons survive (url(), pseudo-ish values)
  assertEquals(parseCssLines("background: url(http://x/y.png)"), {
    background: "url(http://x/y.png)",
  });
});

Deno.test("running entry split/make round-trip; content/area protected", () => {
  const entry = {
    content: "book-title",
    area: "top-right",
    "font-size": "8pt",
    "font-style": "italic",
  };
  const form = splitRunningEntry(entry);
  assertEquals(form.content, "book-title");
  assertEquals(form.area, "top-right");
  assertEquals(parseCssLines(form.extraCss), {
    "font-size": "8pt",
    "font-style": "italic",
  });
  assertEquals(makeRunningEntry(form), entry);
  // A "content: x" line in the extra css cannot clobber the real content key.
  const sneaky = makeRunningEntry({
    content: "page-number",
    area: "bottom-center",
    extraCss: "content: hijacked\narea: top-left\ncolor: red",
  });
  assertEquals(sneaky.content, "page-number");
  assertEquals(sneaky.area, "bottom-center");
  assertEquals(sneaky["color"], "red");
});

Deno.test("renameKey preserves entry order", () => {
  const out = renameKey(
    { body: "EB Garamond", display: "Playfair Display" },
    "body",
    "text",
  );
  assertEquals(Object.keys(out), ["text", "display"]);
  assertEquals(out["text"], "EB Garamond");
});

Deno.test("splitProps partitions curated from extra CSS", () => {
  const { curated, extra } = splitProps({
    "font-size": "9pt",
    "text-align": "center",
    "border-left": "2pt solid #bbb",
    number: { "font-size": "7pt" },
  });
  assertEquals(curated, { "font-size": "9pt", "text-align": "center" });
  assertEquals(extra, { "border-left": "2pt solid #bbb" });
});

Deno.test("page-number style choices exclude 'words'", () => {
  assert(NUMBERING_STYLES.includes("words"));
  assert(!PAGE_NUMBERING_STYLES.includes("words"));
  assertEquals(PAGE_NUMBERING_STYLES.length, NUMBERING_STYLES.length - 1);
});

Deno.test("convertLength converts absolute units, keeps the number otherwise", () => {
  assertEquals(convertLength("72pt", "in"), "1in");
  assertEquals(convertLength("9pt", "mm"), "3.18mm");
  assertEquals(convertLength("1in", "mm"), "25.4mm");
  assertEquals(convertLength("1.5em", "mm"), "1.5mm");
  assertEquals(convertLength("12pt", "em"), "12em");
});

Deno.test("parseLength keeps the unit", () => {
  assertEquals(parseLength("9pt"), { n: 9, unit: "pt" });
  assertEquals(parseLength("1.5em"), { n: 1.5, unit: "em" });
  assertEquals(parseLength("-.5mm"), { n: -0.5, unit: "mm" });
  assertEquals(parseLength("12"), { n: 12, unit: "" });
  assertEquals(parseLength("50%"), { n: 50, unit: "%" });
  assertEquals(parseLength(""), null);
  assertEquals(parseLength("auto"), null);
  assertEquals(stepFor("pt"), 0.5);
  assertEquals(stepFor("lh"), 0.25);
  assertEquals(stepFor("in"), 0.125);
  assertEquals(stepFor(""), 1);
});

Deno.test("bumpLength steps pt by 0.5 and em by 0.05", () => {
  assertEquals(bumpLength("9pt", 1, ""), "9.5pt");
  assertEquals(bumpLength("9pt", -1, ""), "8.5pt");
  assertEquals(bumpLength("0.1em", 1, ""), "0.15em"); // no float noise
  assertEquals(bumpLength("0.3em", 1, ""), "0.35em");
  assertEquals(bumpLength("10mm", 1, ""), "11mm");
  assertEquals(bumpLength("", 1, "11pt"), "11.5pt"); // empty bumps the fallback
  assertEquals(bumpLength("junk", -1, "1em"), "0.95em");
  assertEquals(bumpLength("", 1, ""), "1");
});

Deno.test("runningSummary reports mixed sizes", () => {
  const running = {
    odd: [{ content: "book-title", area: "top-right", "font-size": "8pt" }],
    even: [{
      content: "chapter-title",
      area: "top-left",
      "font-size": "9pt",
      "font-style": "italic",
      "font-family": "body",
    }],
  };
  assertEquals(runningSummary(running), {
    left: "chapter-title",
    right: "book-title",
    size: "mixed",
    italic: "mixed",
    bold: false,
    underline: false,
    font: "mixed",
    color: undefined,
  });
  running.odd[0]!["font-size"] = "9pt";
  assertEquals(runningSummary(running).size, "9pt");
  assertEquals(runningSummary(undefined), {
    left: "none",
    right: "none",
    size: undefined,
    italic: false,
    bold: false,
    underline: false,
    font: undefined,
    color: undefined,
  });
});

Deno.test("setRunningShared writes every entry", () => {
  const odd: RunningEntry[] = [
    { content: "book-title", area: "top-right", "font-size": "8pt" },
    { content: "page-number", area: "bottom-right" },
  ];
  const even = [{ content: "chapter-title", area: "top-left", color: "red" }];
  const running = { odd, even };
  setRunningShared(running, "font-size", "10pt");
  assertEquals(runningSummary(running).size, "10pt");
  assertEquals(even[0]!["color"], "red"); // other keys untouched
  setRunningShared(running, "font-size", undefined);
  assert([...odd, ...even].every((e) => !("font-size" in e)));
  assertEquals(runningSummary(running).color, "mixed"); // only even sets one
  setRunningShared(running, "color", "ink");
  assertEquals(runningSummary(running).color, "ink");
  // Any mix of Italic, Bold and Underline, on every entry at once.
  setRunningShared(running, "font-weight", "bold");
  setRunningShared(running, "text-decoration", "underline");
  const s = runningSummary(running);
  assertEquals([s.italic, s.bold, s.underline], [false, true, true]);
  delete odd[0]!["font-weight"];
  assertEquals(runningSummary(running).bold, "mixed");
});

Deno.test("headPosition reads and setHeadPosition moves the first heads", () => {
  const running = {
    odd: [{ content: "book-title", area: "top-right" }],
    even: [
      { content: "chapter-title", area: "top-left" },
      { content: "page-number", area: "bottom-center" },
    ],
  };
  assertEquals(headPosition(running), "top-outside");
  assertEquals(headPosition({ odd: running.odd }), "top-outside"); // one side
  assertEquals(headPosition(undefined), undefined);
  setHeadPosition(running, "bottom-outside");
  assertEquals(running.odd[0]!.area, "bottom-right");
  assertEquals(running.even.map((e) => e.area), [
    "bottom-left",
    "bottom-center",
  ]);
  running.odd[0]!.area = "left-middle"; // hand-placed in the advanced editor
  assertEquals(headPosition(running), undefined);
});

Deno.test("renameColor renames the color and every reference to it (§4.15)", () => {
  const meta = {
    colors: { ink: "#000", rubric: "#9e2a1e" },
    elements: {
      chapter: { number: { color: "rubric" }, title: { color: "ink" } },
      sidebar: { "border-left-color": "rubric", content: "rubric" },
    },
    is: { note: { color: "rubric" } },
    running: { odd: [{ content: "x", area: "top-right", color: "rubric" }] },
  };
  renameColor(meta, "rubric", "red");
  assertEquals(Object.keys(meta.colors), ["ink", "red"]);
  assertEquals(meta.elements.chapter.number.color, "red");
  assertEquals(meta.elements.chapter.title.color, "ink");
  assertEquals(meta.elements.sidebar["border-left-color"], "red");
  assertEquals(meta.elements.sidebar.content, "rubric"); // not a color
  assertEquals(meta.is.note.color, "red");
  assertEquals(meta.running.odd[0]!.color, "red");
});

Deno.test("emphasisOf reads Italic, Bold and Underline independently", () => {
  assertEquals(emphasisOf({}), {
    italic: false,
    bold: false,
    underline: false,
  });
  assertEquals(
    emphasisOf({
      "font-style": "italic",
      "font-weight": "700",
      "text-decoration": "underline dotted",
    }),
    { italic: true, bold: true, underline: true },
  );
  assertEquals(emphasisOf({ "font-weight": "400" }).bold, false);
});
