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
// How a printed sheet becomes leaves (§4.3, §7.7): folded whole into one
// gathering (folio once, quarto twice, octavo three times), cut into pieces
// that are each folded once, or cut into single leaves with no fold.
export type Fold = "folio" | "quarto" | "octavo" | "cut" | "leaves";

// The physical setup of the edition (§4.3): the book page, the sheet it is
// printed on, and how those sheets are folded into signatures. `size`/`margins`
// drive the preview; `sheet`/`fold`/`folios-per-signature`/`duplex` (and,
// printing the backs by hand, `flip`/`reverse-backs`) drive imposition.
// Everything else about the setup (pages across a sheet, sheets per signature,
// slack to trim off) is derived — see metadata/page-setup.ts.
export interface PageConfig {
  size?: string; // any CSS @page size value (§4.3)
  margins?: PageMargins;
  sheet?: string; // physical paper the printer loads; same value space as `size`
  fold?: Fold; // unset: the fold that puts the most pages on a sheet
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

// Where the folio sits (§4.7). "outside" is the fore-edge corner: right on
// recto, left on verso.
export type FolioPosition =
  | "bottom-center"
  | "bottom-outside"
  | "top-center"
  | "top-outside";

export interface Numbering {
  chapters?: StructureNumbering;
  parts?: StructureNumbering;
  pages?: {
    css?: CssProps; // shared folio styling; each zone's own `css` overrides it
    position?: FolioPosition; // default "bottom-center"
    gap?: string; // folio ↔ text block distance; default DEFAULT_FOLIO_GAP
    "front-matter"?: PageNumbering;
    body?: PageNumbering;
    "back-matter"?: PageNumbering;
    // Chapter and part openers (§4.7): `show: false` drops their folio;
    // `position` moves it (Chicago's drop folio is "bottom-center"). Unset,
    // an opener's folio sits where every other page's does.
    openers?: { show?: boolean; position?: FolioPosition };
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
  gap?: string; // head ↔ text block distance; default DEFAULT_HEAD_GAP
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
  spec?: string; // the spec version this file complies with (§4.2); missing = pre-versioned
  name?: string; // the default edition's display name (§4.1); named editions use their slug
  language?: string; // BCP 47 (§4.2), default "en"; `ebook.language` is the older spelling
  page?: PageConfig;
  fonts?: Record<string, string>;
  elements?: Record<string, ElementStyle>;
  is?: Record<string, CssProps>;
  numbering?: Numbering;
  running?: Running;
  print?: LegacyPrintConfig; // legacy; folded into `page` on load
  notes?: NotesConfig;
  toc?: TocConfig;
  ebook?: EbookConfig;
}

/** The e-book export (spec §4.12): what an EPUB carries that print does not. */
export interface EbookConfig {
  identifier?: string; // e.g. "urn:isbn:9780000000000"; default: a stable urn:uuid from the book slug
  language?: string; // BCP 47; falls back to the top-level `language`
  cover?: string; // image slug in images/
}
