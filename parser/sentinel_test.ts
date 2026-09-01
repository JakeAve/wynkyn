// parser/sentinel_test.ts
import { assertEquals } from "@std/assert";
import { parseSentinelLine } from "./sentinel.ts";

Deno.test("bare sentinel", () => {
  assertEquals(parseSentinelLine("{title}"), {
    closing: false,
    name: "title",
    slug: undefined,
    params: {},
  });
});

Deno.test("sentinel with slug", () => {
  assertEquals(parseSentinelLine("{chapter: thaw}"), {
    closing: false,
    name: "chapter",
    slug: "thaw",
    params: {},
  });
});

Deno.test("slug plus key-value params", () => {
  assertEquals(
    parseSentinelLine("{illustration: orchard-1943 | placement: full-page}"),
    {
      closing: false,
      name: "illustration",
      slug: "orchard-1943",
      params: { placement: "full-page" },
    },
  );
});

Deno.test("param without slug", () => {
  assertEquals(parseSentinelLine("{dropcap | image: initial-T}"), {
    closing: false,
    name: "dropcap",
    slug: undefined,
    params: { image: "initial-T" },
  });
});

Deno.test("closing tag", () => {
  assertEquals(parseSentinelLine("{/sidebar}"), {
    closing: true,
    name: "sidebar",
    slug: undefined,
    params: {},
  });
});

Deno.test("closing is-tag names its class", () => {
  assertEquals(parseSentinelLine("{/is: handwritten-letter}"), {
    closing: true,
    name: "is",
    slug: "handwritten-letter",
    params: {},
  });
});

Deno.test("numeric slug (columns count)", () => {
  assertEquals(parseSentinelLine("{columns: 2}"), {
    closing: false,
    name: "columns",
    slug: "2",
    params: {},
  });
});

Deno.test("surrounding whitespace tolerated", () => {
  assertEquals(
    parseSentinelLine("  {break: passage-of-years}  ")?.slug,
    "passage-of-years",
  );
});

Deno.test("prose containing inline tags is not a sentinel line", () => {
  assertEquals(
    parseSentinelLine("She saw the {em}Queen Mary{/em} at dock."),
    null,
  );
});

Deno.test("escaped line is not a sentinel", () => {
  assertEquals(parseSentinelLine("\\{title}"), null);
});

Deno.test("comment is not a sentinel", () => {
  assertEquals(parseSentinelLine("%% {chapter: x} in a comment"), null);
});
