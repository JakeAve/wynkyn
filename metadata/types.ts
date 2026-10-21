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

export type Duplex = "short-edge" | "long-edge" | "none";
export type Flip = Exclude<Duplex, "none">;

// The physical setup of the edition (§4.3): the book page, the sheet it is
// printed on, and how those sheets are folded into signatures. `size`/`margins`
// drive the preview; `sheet`/`folios-per-signature`/`duplex` (and, printing
// the backs by hand, `flip`/`reverse-backs`) drive imposition.
// Everything else about the setup (pages across a sheet, sheets per signature,
// slack to trim off) is derived — see metadata/page-setup.ts.
export interface PageConfig {
  size?: string; // any CSS @page size value (§4.3)
  margins?: PageMargins;
  sheet?: string; // physical paper the printer loads; same value space as `size`
  "folios-per-signature"?: number | "booklet"; // booklet: every page in one signature
  duplex?: Duplex;
  flip?: Flip; // which edge the stack turns over on for its backs, duplex "none"
  "reverse-backs"?: boolean; // backs file in reverse sheet order, duplex "none"
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
    css?: CssProps; // shared folio styling; each zone's own `css` overrides it
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

// Pre-merge shape of the print settings, read only by the upgrade in
// metadata/loader.ts. Nothing else may consume it; the live keys are on `page`.
export interface LegacyPrintConfig {
  "sheet-size"?: string;
  "folios-per-signature"?: number;
  duplex?: Duplex;
}

export interface NotesConfig {
  placement?: "footnote" | "endnote";
}

// Which structure the generated contents lists beyond parts, chapters and
// titled matter (spec §4.12). Everything visual about the TOC is CSS (§4.5).
export interface TocConfig {
  headings?: boolean; // list level-1 {heading: slug}s under their chapter
}

export interface Metadata {
  page?: PageConfig;
  fonts?: Record<string, string>;
  elements?: Record<string, ElementStyle>;
  is?: Record<string, CssProps>;
  numbering?: Numbering;
  running?: Running;
  print?: LegacyPrintConfig; // legacy; folded into `page` on load
  notes?: NotesConfig;
  toc?: TocConfig;
}
