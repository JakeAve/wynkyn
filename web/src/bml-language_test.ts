import { assertEquals } from "@std/assert";
import { StringStream } from "@codemirror/language";
import {
  type BmlStreamState,
  bmlToken,
  classifyLines,
  emRanges,
  structuralBlock,
  styleKeysAt,
} from "./bml-language.ts";

// Run the tokenizer over one line, collecting [style, consumedText] pairs.
function tokenize(
  line: string,
  state: BmlStreamState = { tag: null },
): [string | null, string][] {
  const stream = new StringStream(line, 4, 2);
  const out: [string | null, string][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = bmlToken(stream, state);
    out.push([style, line.slice(stream.start, stream.pos)]);
  }
  return out;
}

Deno.test("comment line is a single comment token", () => {
  assertEquals(tokenize("%% never printed"), [["comment", "%% never printed"]]);
});

Deno.test("sentinel with slug and key-value pair", () => {
  assertEquals(tokenize("{verses: genesis-1 | start: 3}"), [
    ["bracket", "{"],
    ["keyword", "verses"],
    ["punctuation", ":"],
    [null, " "],
    ["labelName", "genesis-1"],
    [null, " "],
    ["punctuation", "|"],
    [null, " "],
    ["propertyName", "start"],
    ["punctuation", ":"],
    [null, " "],
    ["string", "3"],
    ["bracket", "}"],
  ]);
});

Deno.test("closing tag with class name", () => {
  assertEquals(tokenize("{/is: telegram}"), [
    ["bracket", "{"],
    ["punctuation", "/"],
    ["keyword", "is"],
    ["punctuation", ":"],
    [null, " "],
    ["labelName", "telegram"],
    ["bracket", "}"],
  ]);
});

Deno.test("inline em inside prose", () => {
  assertEquals(tokenize("saw the {em}Queen Mary{/em} at dock."), [
    [null, "saw the "],
    ["bracket", "{"],
    ["keyword", "em"],
    ["bracket", "}"],
    [null, "Queen Mary"],
    ["bracket", "{"],
    ["punctuation", "/"],
    ["keyword", "em"],
    ["bracket", "}"],
    [null, " at dock."],
  ]);
});

Deno.test("escapes and hard line break", () => {
  assertEquals(tokenize("\\{ literal brace"), [
    ["escape", "\\{"],
    [null, " literal brace"],
  ]);
  assertEquals(tokenize("where it is going.\\"), [
    [null, "where it is going."],
    ["escape", "\\"],
  ]);
});

Deno.test("unterminated tag resets at the next line", () => {
  const state: BmlStreamState = { tag: null };
  tokenize("{chapter: thaw", state); // malformed: no closing brace
  assertEquals(tokenize("plain prose", state), [[null, "plain prose"]]);
});

Deno.test("classifyLines: structural, fields, and the line after a title", () => {
  assertEquals(
    classifyLines([
      "{chapter: one}",
      "{title}",
      "Chapter One",
      "{subtitle}",
      "In which",
      "{heading}",
      "",
      "Prose.",
    ]),
    [
      ["struct"],
      ["field"],
      ["strong"],
      ["field"],
      ["italic"],
      ["field"],
      [],
      [],
    ],
  );
});

Deno.test("styleKeysAt: struct, field text, block prose, bare prose", () => {
  const lines = [
    "{matter: title-page}",
    "{title}",
    "The Book",
    "{author}",
    "A. Writer",
    "",
    "{chapter: one}",
    "{title}",
    "One",
    "",
    "Prose.",
    "{epigraph}",
    "Words.",
    "{attribution}",
    "— Someone",
    "{/epigraph}",
    "{is: letter}",
    "Dear",
    "{/is: letter}",
    "{heading}",
    "A head",
    "{illustration: fig}",
    "Caption",
    "{break}",
  ];
  const at = (n: number) => styleKeysAt(lines, n);
  assertEquals(at(1), ["title-page"]);
  assertEquals(at(3), ["title-page.title", "title-page"]);
  assertEquals(at(5), ["title-page.author", "title-page"]);
  assertEquals(at(6), ["title-page"]); // blank prose on a matter page
  assertEquals(at(7), ["chapter"]);
  assertEquals(at(9), ["chapter.title", "chapter"]);
  assertEquals(at(11), ["paragraph"]);
  assertEquals(at(13), ["epigraph.text", "epigraph"]);
  assertEquals(at(15), ["epigraph.attribution", "epigraph"]);
  assertEquals(at(18), ["is.letter"]);
  assertEquals(at(21), ["heading"]);
  assertEquals(at(23), ["illustration.caption", "illustration"]);
  assertEquals(at(24), ["break"]);
});

Deno.test("classifyLines: block rails run tag to tag, or to EOF unclosed", () => {
  assertEquals(
    classifyLines(["a", "{quote}", "b", "{/quote}", "c", "{poem}", "d"]),
    [[], ["rail"], ["rail"], ["rail"], [], ["rail"], ["rail"]],
  );
  // nested pairs and a stray closer
  assertEquals(
    classifyLines([
      "{sidebar}",
      "{quote}",
      "x",
      "{/quote}",
      "{/sidebar}",
      "{/is}",
    ]),
    [["rail"], ["rail"], ["rail"], ["rail"], ["rail"], []],
  );
});

Deno.test("classifyLines: box-drawing comments are rules, a label between them", () => {
  assertEquals(
    classifyLines(["%% ──────", "%% Body matter", "%% ──────", "%% note"]),
    [["rule"], ["label"], ["rule"], []],
  );
});

Deno.test("emRanges: tags and the text between", () => {
  assertEquals(emRanges("a {em}bc{/em} \\{em}x"), [[2, 6, 8, 13]]);
});

Deno.test("structuralBlock: from the structural line at or above to before the next", () => {
  const lines = ["front", "{chapter: a}", "x", "y", "{part: b}", "z"];
  const at = (n: number) => lines[n - 1]!;
  assertEquals(structuralBlock(at, lines.length, 3), [2, 4]);
  assertEquals(structuralBlock(at, lines.length, 2), [2, 4]);
  assertEquals(structuralBlock(at, lines.length, 1), [1, 1]);
  assertEquals(structuralBlock(at, lines.length, 6), [5, 6]);
});
