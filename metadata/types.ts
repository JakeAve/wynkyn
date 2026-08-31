// metadata/types.ts — mirrors book-renderer-spec.md §4 one-to-one.

export type CssProps = Record<string, string>;

// An element entry: CSS props, and/or nested sub-element props (spec §4.5).
// Nesting is recursive so a row-level sub-element can style its own spans,
// e.g. elements.toc["toc-part"].number → `.matter-toc .toc-part .number`.
export type ElementStyle = { [prop: string]: string | ElementStyle };

export interface PageMargins {
  top?: string;
  bottom?: string;
  inside?: string;
  outside?: string;
}

export interface PageConfig {
  size?: string; // any CSS @page size value (§4.3)
  margins?: PageMargins;
}

export type NumberingStyle =
  | "arabic"
  | "roman-upper"
  | "roman-lower"
  | "alpha-upper"
  | "alpha-lower"
  | "words" // One, Two … Ninety-Nine; chapters/parts only (§4.7)
  | "none";

export interface StructureNumbering {
  style?: NumberingStyle;
  show?: boolean;
  prefix?: string;
  suffix?: string;
}

export interface PageNumbering {
  style?: NumberingStyle;
  show?: boolean;
  css?: CssProps; // styles the folio's margin box (§4.7)
}

export interface Numbering {
  chapters?: StructureNumbering;
  parts?: StructureNumbering;
  pages?: {
    "front-matter"?: PageNumbering;
    body?: PageNumbering;
    "back-matter"?: PageNumbering;
  };
}

// content: "book-title" | "chapter-title" | "part-title" | "page-number" | "none" | literal.
// area: one of the 16 CSS margin boxes (§4.8). All other keys are CSS props for that box.
export interface RunningEntry {
  content: string;
  area: string;
  [cssProp: string]: string;
}

export interface Running {
  odd?: RunningEntry[];
  even?: RunningEntry[];
}

export interface PrintConfig {
  "sheet-size"?: string;
  "folios-per-signature"?: number;
  duplex?: "short-edge" | "long-edge" | "none";
}

export interface NotesConfig {
  placement?: "footnote" | "endnote";
}

export interface Metadata {
  page?: PageConfig;
  fonts?: Record<string, string>;
  elements?: Record<string, ElementStyle>;
  is?: Record<string, CssProps>;
  numbering?: Numbering;
  running?: Running;
  print?: PrintConfig;
  notes?: NotesConfig;
}
