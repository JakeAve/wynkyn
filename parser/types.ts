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
}

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

// Matter types the generated contents never lists — display pages that carry
// no entry of their own (spec §3.4.6). Shared with the renderer so the parser
// can warn about a block that would silently vanish from the contents.
export const DISPLAY_MATTER: ReadonlySet<string> = new Set([
  "half-title",
  "title-page",
  "copyright",
  "dedication",
  "epigraph",
  "toc",
]);
