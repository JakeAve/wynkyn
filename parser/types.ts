// parser/types.ts — the BmlDocument tree (spec §5.1), mirroring the tag reference §3.9.

export interface Diagnostic {
  line: number; // 1-based source line
  message: string;
}

export interface BmlDocument {
  frontMatter: MatterBlock[];
  body: BodyBlock[];
  backMatter: MatterBlock[];
  diagnostics: Diagnostic[];
  onlySpans: OnlySpan[]; // EXPERIMENTAL: every {only} span, kept or dropped
}

// EXPERIMENTAL (spec §3.2.9): `{only: a | b}` … `{/only}` gates whole blocks to
// the named editions. `line`/`endLine` are the tag lines (endLine = last line
// when unclosed).
export interface OnlySpan {
  line: number;
  endLine: number;
  editions: string[];
}

// The `{only}` token that names the book's default edition.
export const DEFAULT_EDITION_TOKEN = "default";

export type BodyBlock = Part | Chapter;

export interface MatterBlock {
  kind: "matter";
  type: string; // "half-title" | "title-page" | "copyright" | ... (open set)
  label?: string; // {matter: appendix | label: A}
  children: ContentNode[];
  line: number;
}

export interface Part {
  kind: "part";
  slug: string;
  children: (Chapter | ContentNode)[];
  line: number;
}

export interface Chapter {
  kind: "chapter";
  slug: string;
  children: ContentNode[];
  line: number;
}

export type ContentNode =
  | Paragraph
  | Component
  | DropcapParagraph
  | Heading
  | Break
  | Epigraph
  | Quote
  | Poem
  | Pullquote
  | Sidebar
  | Verses
  | Columns
  | IsBlock
  | Illustration
  | List
  | Note;

export interface Paragraph {
  kind: "paragraph";
  inlines: Inline[];
  line: number;
}

export type ComponentName =
  | "title"
  | "subtitle"
  | "author"
  | "editor"
  | "translator"
  | "publisher"
  | "publisher-location"
  | "year"
  | "edition"
  | "series"
  | "series-number"
  | "copyright-line"
  | "rights"
  | "isbn"
  | "printer"
  | "typeface"
  | "paper"
  | "binding"
  | "attribution";

export interface Component {
  kind: "component";
  name: ComponentName;
  inlines: Inline[];
  line: number;
}

export interface DropcapParagraph {
  kind: "dropcap";
  image?: string; // {dropcap | image: initial-T}
  inlines: Inline[];
  line: number;
}

export interface Heading {
  kind: "heading";
  level: 1 | 2; // {heading} = 1, {subheading} = 2
  slug?: string;
  inlines: Inline[];
  line: number;
}

export interface Break {
  kind: "break";
  slug?: string;
  line: number;
}

export interface Epigraph {
  kind: "epigraph";
  children: ContentNode[];
  attribution?: Component;
  line: number;
}

export interface Quote {
  kind: "quote";
  children: ContentNode[];
  attribution?: Component;
  line: number;
}

export interface Poem {
  kind: "poem";
  stanzas: Paragraph[]; // one Paragraph per stanza; linebreak inlines separate lines
  attribution?: Component;
  line: number;
}

export interface Pullquote {
  kind: "pullquote";
  children: ContentNode[];
  attribution?: Component;
  line: number;
}

export interface Sidebar {
  kind: "sidebar";
  children: ContentNode[];
  line: number;
}

export interface Verses {
  kind: "verses";
  slug: string;
  start: number; // default 1; {verses: slug | start: 3}
  verses: (Paragraph | DropcapParagraph)[]; // verse number = start + index
  line: number;
}

export interface Columns {
  kind: "columns";
  count: number;
  mode: "flow" | "parallel"; // parallel iff a {col} divider appeared
  columns: ContentNode[][]; // flow mode: exactly one entry
  line: number;
}

export interface IsBlock {
  kind: "is";
  className: string;
  children: ContentNode[];
  line: number;
}

export interface Illustration {
  kind: "illustration";
  slug: string;
  placement?: "inline" | "half-page" | "full-page" | "full-spread" | "margin";
  caption?: Inline[];
  line: number;
}

export interface List {
  kind: "list";
  ordered: boolean;
  start?: number; // ordered lists: number of the first item
  items: Inline[][];
  line: number;
}

export interface Note {
  kind: "note";
  slug: string;
  inlines: Inline[];
  line: number;
}

export type Inline =
  | TextInline
  | EmInline
  | FootnoteInline
  | RefInline
  | LineBreakInline;

export interface TextInline {
  kind: "text";
  text: string;
}

export interface EmInline {
  kind: "em";
  children: Inline[];
}

export interface FootnoteInline {
  kind: "footnote";
  slug: string;
}

export interface RefInline {
  kind: "ref";
  slug: string;
}

export interface LineBreakInline {
  kind: "linebreak";
}

// An `{is:}` name becomes a CSS class and selector (`.is-<name>`), so it is
// held to the slug rule (§3.2.4).
export const CLASS_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MatterType {
  // A titled block gets a contents row (§3.4.6); the parser warns when a
  // listed block has no {title}, since it would silently vanish.
  listed: boolean;
  // Set on the display page: no folio, no running head (§4.7). The renderer
  // classes the block `matter-display`, which base.css names the page on.
  display: boolean;
  // Styled together under the `prose-matter` key (§4.5).
  prose: boolean;
}

// The one list of known matter types (§3.4, §3.7). The set is open: a type not
// here is listed, set on ordinary pages, and styled under its own key.
export const MATTER_TYPES: Readonly<Record<string, MatterType>> = {
  "half-title": { listed: false, display: true, prose: false },
  "title-page": { listed: false, display: true, prose: false },
  copyright: { listed: false, display: true, prose: false },
  dedication: { listed: false, display: true, prose: false },
  epigraph: { listed: false, display: true, prose: false },
  toc: { listed: false, display: false, prose: false },
  foreword: { listed: true, display: false, prose: true },
  preface: { listed: true, display: false, prose: true },
  introduction: { listed: true, display: false, prose: true },
  appendix: { listed: true, display: false, prose: false },
  bibliography: { listed: true, display: false, prose: false },
  index: { listed: true, display: false, prose: false },
  colophon: { listed: false, display: true, prose: false },
};

const OPEN_TYPE: MatterType = { listed: true, display: false, prose: false };

export function matterType(type: string): MatterType {
  return Object.hasOwn(MATTER_TYPES, type) ? MATTER_TYPES[type]! : OPEN_TYPE;
}
