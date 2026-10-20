import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  bumpLength,
  formatCssLines,
  isValidFolios,
  isValidSize,
  makeRunningEntry,
  NUMBERING_STYLES,
  PAGE_NUMBERING_STYLES,
  parseCssLines,
  parseLength,
  presetFor,
  renameKey,
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
