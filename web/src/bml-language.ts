// web/src/bml-language.ts — CodeMirror 6 language support for BML (spec §3.2):
// sentinels, slugs, key/value pairs, comments, escapes, hard line breaks.
// A stream parser suffices because a sentinel never spans lines. Line
// decorations on top style sentinels by kind (structural, field, block, wrap).
import {
  HighlightStyle,
  StreamLanguage,
  type StringStream,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  type Extension,
  type Range,
  RangeSet,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutterLineClass,
  GutterMarker,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { parseSentinelLine } from "../../parser/sentinel.ts";

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

// Colors are CSS variables from the chrome's tokens, so one highlight
// style serves light and dark without a reconfigure. Markup is set in --f-mono
// whatever font the writer picks for prose, so it reads as markup.
const mono = "var(--f-mono)";
const bmlHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "var(--syn-c)", fontStyle: "italic" },
  {
    tag: tags.keyword,
    color: "var(--syn-k)",
    fontWeight: "500",
    fontFamily: mono,
  },
  { tag: tags.labelName, color: "var(--syn-p)", fontFamily: mono },
  { tag: tags.propertyName, color: "var(--muted)", fontFamily: mono },
  { tag: tags.string, color: "var(--syn-t)", fontFamily: mono },
  { tag: tags.bracket, color: "var(--syn-p)", fontFamily: mono },
  { tag: tags.punctuation, color: "var(--syn-p)", fontFamily: mono },
  {
    tag: tags.escape,
    color: "var(--syn-k)",
    fontWeight: "bold",
    fontFamily: mono,
  },
]));

// ---- sentinels by kind (UX round 1): line classes and gutter marks ----

export const STRUCTURAL = new Set(["matter", "part", "chapter"]);
const BLOCKS = new Set([
  "quote",
  "epigraph",
  "poem",
  "pullquote",
  "sidebar",
  "verses",
  "columns",
  "is",
]);
const NEXT_KIND: Record<string, LineKind> = {
  title: "strong",
  heading: "strong",
  subheading: "strong",
  subtitle: "italic",
};
// A `%%` line made only of box-drawing characters (U+2500–U+257F).
export const RULE_RE = /^%%\s*[─-╿]+\s*$/;

// One rule, by closing form (§3.2.3): a nesting-close sentinel is a struct,
// an explicit-close pair is a rail, and every other sentinel line — fields,
// markers, point sentinels — is a field.
export type LineKind =
  | "struct" // {matter} / {part} / {chapter}
  | "field" // {title}, {author}, {heading}, {break}, … — small and muted
  | "rail" // inside a block pair, tags inclusive
  | "strong" // the line after {title} / {heading} / {subheading}
  | "italic" // the line after {subtitle}
  | "rule" // %% ─────
  | "label"; // a %% line between two rules

export function isStructural(line: string): boolean {
  const t = parseSentinelLine(line);
  return !!t && !t.closing && STRUCTURAL.has(t.name);
}

// The kinds of every line (index i = line i + 1). Rails run from a block's
// opening tag to its closing tag, or to the end when it never closes.
export function classifyLines(lines: string[]): LineKind[][] {
  const rule = lines.map((l) => RULE_RE.test(l));
  const open: string[] = [];
  let next: LineKind | null = null;
  return lines.map((text, i) => {
    const kinds: LineKind[] = [];
    const t = parseSentinelLine(text);
    if (next && !t && text.trim() !== "") kinds.push(next);
    next = null;
    if (rule[i]) kinds.push("rule");
    else if (text.startsWith("%%") && rule[i - 1] && rule[i + 1]) {
      kinds.push("label");
    }
    if (t) {
      if (!t.closing && STRUCTURAL.has(t.name)) kinds.push("struct");
      else if (!BLOCKS.has(t.name)) kinds.push("field");
      next = t.closing ? null : NEXT_KIND[t.name] ?? null;
      if (BLOCKS.has(t.name)) {
        if (!t.closing) open.push(t.name);
        else if (open.includes(t.name)) {
          kinds.push("rail");
          open.length = open.lastIndexOf(t.name);
        }
      }
    }
    if (open.length && !kinds.includes("rail")) kinds.push("rail");
    return kinds;
  });
}

// Inline wrap tags on one line (spec §3.2.3), in order: `{em}…{/em}` as
// [tagStart, textStart, textEnd, tagEnd], and the point tags
// `{footnote: slug}` / `{ref: slug}` as [tagStart, slugStart, slugEnd, tagEnd].
// ponytail: single-line only; a wrap spanning lines stays plain.
export function wrapRanges(
  line: string,
): { name: string; at: [number, number, number, number] }[] {
  const out: { name: string; at: [number, number, number, number] }[] = [];
  for (const m of line.matchAll(/(?<!\\)\{em\}(.*?)(?<!\\)\{\/em\}/g)) {
    const a = m.index, b = a + m[0].length;
    out.push({ name: "em", at: [a, a + 4, b - 5, b] });
  }
  for (
    const m of line.matchAll(/(?<!\\)\{(footnote|ref)\s*:\s*([^}]*?)\s*\}/dg)
  ) {
    const [s, e] = m.indices![2]!;
    out.push({ name: m[1]!, at: [m.index, s, e, m.index + m[0].length] });
  }
  return out.sort((x, y) => x.at[0] - y.at[0]);
}

// The structural block holding `line` (1-based): from the nearest
// {matter}/{part}/{chapter} at or above it to the line before the next.
export function structuralBlock(
  lineText: (n: number) => string,
  lines: number,
  line: number,
): [number, number] {
  let from = line;
  while (from > 1 && !isStructural(lineText(from))) from--;
  let to = line + 1;
  while (to <= lines && !isStructural(lineText(to))) to++;
  return [from, to - 1];
}

// Matter types that have a catalog type of their own; the rest are prose.
const MATTER_TYPE: Record<string, string> = {
  foreword: "prose-matter",
  preface: "prose-matter",
  introduction: "prose-matter",
};
// Field sentinels whose text is styled by the enclosing matter page.
const PAGE_FIELDS = new Set([
  "title",
  "subtitle",
  "author",
  "edition",
  "epigraph",
  "imprint",
  "copyright-line",
  "rights",
  "isbn",
]);

// The style-catalog keys for what `line` (1-based) is part of, most specific
// first: "chapter.title" then "chapter"; "epigraph.attribution" then
// "epigraph"; a bare paragraph is "paragraph". The caller keeps the first key
// its catalog has. Empty when the line belongs to nothing stylable.
// ponytail: rescans from the top on every cursor move; cache per doc if it lags.
export function styleKeysAt(lines: string[], line: number): string[] {
  let struct = ""; // the catalog type of the enclosing matter/part/chapter
  const open: string[] = []; // enclosing blocks, keys, innermost last
  let field: string[] = []; // keys of the field whose text runs on
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const text = lines[i]!;
    const t = parseSentinelLine(text);
    if (!t) {
      if (text.trim() === "") field = [];
      continue;
    }
    field = [];
    const key = t.name === "is" ? `is.${t.slug ?? ""}` : t.name;
    if (t.closing) {
      if (open.includes(key)) open.length = open.lastIndexOf(key);
      continue;
    }
    if (STRUCTURAL.has(t.name)) {
      struct = t.name === "matter"
        ? (MATTER_TYPE[t.slug ?? ""] ?? t.slug ?? "")
        : t.name;
      open.length = 0;
      field = [struct];
    } else if (BLOCKS.has(t.name)) {
      open.push(key);
    } else if (t.name === "attribution") {
      const b = open.at(-1) ?? "epigraph";
      field = [`${b}.attribution`, b];
    } else if (t.name === "illustration") {
      field = ["illustration.caption", "illustration"];
    } else if (t.name === "note") field = ["footnote"];
    else if (PAGE_FIELDS.has(t.name)) field = [`${struct}.${t.name}`, struct];
    else field = [t.name]; // heading, subheading, break, dropcap, …
  }
  if (field.length) return field;
  const block = open.at(-1);
  if (block === "epigraph") return ["epigraph.text", "epigraph"];
  if (block) return [block];
  // Prose: a paragraph in the text, or the page itself in matter that has no
  // paragraph style of its own (dedication, colophon).
  if (["chapter", "part", "prose-matter", "appendix", ""].includes(struct)) {
    return ["paragraph"];
  }
  return [struct];
}

const lineDeco = (kind: LineKind) =>
  Decoration.line({ class: `cm-bml-${kind}` });
const LINE_DECOS = {
  struct: lineDeco("struct"),
  field: lineDeco("field"),
  rail: lineDeco("rail"),
  strong: lineDeco("strong"),
  italic: lineDeco("italic"),
  rule: lineDeco("rule"),
  label: lineDeco("label"),
} satisfies Record<LineKind, Decoration>;
const emTag = Decoration.mark({ class: "cm-bml-wrap" });
const emText = Decoration.mark({ class: "cm-bml-it" });
export class ClassMarker extends GutterMarker {
  constructor(override readonly elementClass: string) {
    super();
  }
}
const structGutter = new ClassMarker("cm-bml-struct");

interface KindDecos {
  lines: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}

function buildKinds(doc: Text): KindDecos {
  const text = doc.toString().split("\n");
  const kinds = classifyLines(text);
  const decos: Range<Decoration>[] = [];
  const marks: Range<GutterMarker>[] = [];
  let pos = 0;
  text.forEach((line, i) => {
    for (const k of kinds[i] ?? []) decos.push(LINE_DECOS[k].range(pos));
    if (kinds[i]?.includes("struct")) marks.push(structGutter.range(pos));
    for (const { name, at: [a, b, c, d] } of wrapRanges(line)) {
      if (name !== "em") continue;
      decos.push(emTag.range(pos + a, pos + b));
      if (c > b) decos.push(emText.range(pos + b, pos + c));
      decos.push(emTag.range(pos + c, pos + d));
    }
    pos += line.length + 1;
  });
  return { lines: Decoration.set(decos, true), gutter: RangeSet.of(marks) };
}

// ponytail: whole-document rescan on every edit; scan the viewport if it lags.
const bmlKinds = StateField.define<KindDecos>({
  create: (state) => buildKinds(state.doc),
  update: (v, tr) => tr.docChanged ? buildKinds(tr.state.doc) : v,
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.lines),
    gutterLineClass.from(f, (v) => v.gutter),
  ],
});

export function bml(): Extension[] {
  return [bmlLanguage, bmlHighlight, bmlKinds];
}
