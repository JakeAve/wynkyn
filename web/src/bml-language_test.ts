import { assertEquals } from "jsr:@std/assert";
import { StringStream } from "@codemirror/language";
import { bmlToken, type BmlStreamState } from "./bml-language.ts";

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
