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

export function bmlToken(
  stream: StringStream,
  state: BmlStreamState,
): string | null {
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
    while (!stream.eol() && stream.peek() !== "{" && stream.peek() !== "\\") {
      stream.next();
    }
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

// Colors are CSS variables from index.html's Ink palette, so one highlight
// style serves light and dark without a reconfigure.
const bmlHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "var(--syn-c)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--syn-k)", fontWeight: "600" },
  { tag: tags.labelName, color: "var(--syn-slug)" },
  { tag: tags.propertyName, color: "var(--syn-key)" },
  { tag: tags.string, color: "var(--syn-t)" },
  { tag: tags.bracket, color: "var(--syn-p)" },
  { tag: tags.punctuation, color: "var(--syn-p)" },
  { tag: tags.escape, color: "var(--syn-k)", fontWeight: "bold" },
]));

export function bml(): Extension[] {
  return [bmlLanguage, bmlHighlight];
}
