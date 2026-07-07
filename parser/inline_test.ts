// parser/inline_test.ts
import { assertEquals } from "jsr:@std/assert";
import { parseInlines } from "./inline.ts";

Deno.test("plain prose, multi-line joins with space", () => {
  assertEquals(parseInlines(["one two", "three"]), [
    { kind: "text", text: "one two three" },
  ]);
});

Deno.test("em span", () => {
  assertEquals(parseInlines(["saw the {em}Queen Mary{/em} at dock"]), [
    { kind: "text", text: "saw the " },
    { kind: "em", children: [{ kind: "text", text: "Queen Mary" }] },
    { kind: "text", text: " at dock" },
  ]);
});

Deno.test("unclosed em extends to paragraph end", () => {
  assertEquals(parseInlines(["a {em}b c"]), [
    { kind: "text", text: "a " },
    { kind: "em", children: [{ kind: "text", text: "b c" }] },
  ]);
});

Deno.test("footnote and ref point markers", () => {
  assertEquals(parseInlines(["poor.{footnote: harvest-1943} See {ref: thaw}."]), [
    { kind: "text", text: "poor." },
    { kind: "footnote", slug: "harvest-1943" },
    { kind: "text", text: " See " },
    { kind: "ref", slug: "thaw" },
    { kind: "text", text: "." },
  ]);
});

Deno.test("hard line break", () => {
  assertEquals(parseInlines(["The water does not ask\\", "where it is going."]), [
    { kind: "text", text: "The water does not ask" },
    { kind: "linebreak" },
    { kind: "text", text: "where it is going." },
  ]);
});

Deno.test("double backslash at EOL is a literal backslash, not a break", () => {
  assertEquals(parseInlines(["a\\\\", "b"]), [
    { kind: "text", text: "a\\ b" },
  ]);
});

Deno.test("escaped brace is literal", () => {
  assertEquals(parseInlines(["a \\{title} b"]), [
    { kind: "text", text: "a {title} b" },
  ]);
});

Deno.test("leading backslash is stripped", () => {
  assertEquals(parseInlines(["\\- not a list item"]), [
    { kind: "text", text: "- not a list item" },
  ]);
});

Deno.test("unknown braces pass through as prose", () => {
  assertEquals(parseInlines(["set in {curly} type"]), [
    { kind: "text", text: "set in {curly} type" },
  ]);
});

Deno.test("nested em is tolerated", () => {
  assertEquals(parseInlines(["{em}a {em}b{/em} c{/em}"]), [
    {
      kind: "em",
      children: [
        { kind: "text", text: "a " },
        { kind: "em", children: [{ kind: "text", text: "b" }] },
        { kind: "text", text: " c" },
      ],
    },
  ]);
});
