// web/src/bml-language.ts — CodeMirror 6 language support for BML (spec §3.2):
// sentinels, slugs, key/value pairs, comments, escapes, hard line breaks.
// A stream parser suffices because a sentinel never spans lines.
import {
  HighlightStyle,
  StreamLanguage,
  type StringStream,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

// Which field of a {sentinel: slug | key: value} the next token belongs to.
export type TagField = "name" | "slug" | "key" | "value";

export interface BmlStreamState {
  tag: TagField | null; // null = in prose
}

export function bmlToken(stream: StringStream, state: BmlStreamState): string | null {
  // A sentinel never spans lines — an unterminated tag resets at the next line.
  if (state.tag !== null && stream.sol()) state.tag = null;

  if (state.tag === null) {
    if (stream.sol() && stream.match(/^%%.*/)) return "comment";
    if (stream.match(/^\\$/)) return "escape"; // hard line break (§3.2.6)
    if (stream.match(/^\\./)) return "escape"; // \{, \-, \%%, \\ (§3.2.8)
    if (stream.peek() === "{") {
      stream.next();
      state.tag = "name";
      return "bracket";
    }
    // prose: advance to the next markup-significant character
    while (!stream.eol() && stream.peek() !== "{" && stream.peek() !== "\\") stream.next();
    return null;
  }

  // inside {...}
  if (stream.peek() === "}") {
    stream.next();
    state.tag = null;
    return "bracket";
  }
  if (stream.match(/^\//)) return "punctuation"; // closing form {/em}
  if (stream.match(/^\|/)) {
    state.tag = "key";
    return "punctuation";
  }
  if (stream.match(/^:/)) {
    state.tag = state.tag === "key" ? "value" : "slug";
    return "punctuation";
  }
  if (stream.match(/^\s+/)) return null;
  const style = state.tag === "name"
    ? "keyword"
    : state.tag === "slug"
    ? "labelName"
    : state.tag === "key"
    ? "propertyName"
    : "string";
  if (stream.match(/^[^:|}\s]+/)) return style;
  stream.next(); // unexpected character — always advance, never loop
  return null;
}

export const bmlLanguage = StreamLanguage.define<BmlStreamState>({
  name: "bml",
  startState: () => ({ tag: null }),
  token: bmlToken,
});

// Colors chosen for the One Dark chrome added in Task 4.
const bmlHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "#7a7f8a", fontStyle: "italic" },
  { tag: tags.keyword, color: "#61afef" },
  { tag: tags.labelName, color: "#d19a66" },
  { tag: tags.propertyName, color: "#98c379" },
  { tag: tags.string, color: "#e5c07b" },
  { tag: tags.bracket, color: "#56b6c2" },
  { tag: tags.punctuation, color: "#56b6c2" },
  { tag: tags.escape, color: "#c678dd", fontWeight: "bold" },
]));

export function bml(): Extension[] {
  return [bmlLanguage, bmlHighlight];
}
