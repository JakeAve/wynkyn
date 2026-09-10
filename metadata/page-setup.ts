// metadata/page-setup.ts — the physical page setup (spec §4.3): the book page,
// the sheet it prints on, and everything the two together imply. Pure and
// dependency-free (no Deno APIs) so the config panel and the print exporter
// share one source of truth for this geometry.
import type { Duplex, PageConfig } from "./types.ts";

export interface Dims {
  w: number;
  h: number;
}

export type Unit = "in" | "mm";

// Inches per CSS unit. `in` is the internal unit for every dimension here.
const PER_UNIT: Record<string, number> = {
  in: 1,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  pt: 1 / 72,
  pc: 1 / 6,
  px: 1 / 96,
};

interface NamedSheet {
  dims: Dims;
  unit: Unit; // how sizes derived from this sheet read back
}

// The CSS `@page { size: }` named sizes, plus `tabloid` as the common alias
// for ledger's portrait orientation. Orientation is irrelevant to imposition
// (nUp works off the long and short sides) but is kept true to CSS here.
const NAMED: Record<string, NamedSheet> = {
  a3: { dims: { w: 297 / 25.4, h: 420 / 25.4 }, unit: "mm" },
  a4: { dims: { w: 210 / 25.4, h: 297 / 25.4 }, unit: "mm" },
  a5: { dims: { w: 148 / 25.4, h: 210 / 25.4 }, unit: "mm" },
  b4: { dims: { w: 250 / 25.4, h: 353 / 25.4 }, unit: "mm" },
  b5: { dims: { w: 176 / 25.4, h: 250 / 25.4 }, unit: "mm" },
  "jis-b4": { dims: { w: 257 / 25.4, h: 364 / 25.4 }, unit: "mm" },
  "jis-b5": { dims: { w: 182 / 25.4, h: 257 / 25.4 }, unit: "mm" },
  letter: { dims: { w: 8.5, h: 11 }, unit: "in" },
  legal: { dims: { w: 8.5, h: 14 }, unit: "in" },
  ledger: { dims: { w: 17, h: 11 }, unit: "in" },
  tabloid: { dims: { w: 11, h: 17 }, unit: "in" },
};

export function namedSizes(): string[] {
  return Object.keys(NAMED);
}

/** "legal" | "5.25in 8in" | "148mm 210mm" → inches; null if it isn't a size (§4.3). */
export function tryParseDims(size: string): Dims | null {
  const trimmed = size.trim();
  const named = NAMED[trimmed.toLowerCase()];
  if (named) return named.dims;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2) return null;
  const lengths: number[] = [];
  for (const part of parts) {
    const m = part.match(/^(\d+(?:\.\d+)?)(in|mm|cm|pt|pc|px)$/);
    const per = m ? PER_UNIT[m[2]!] : undefined;
    if (!m || per === undefined) return null;
    lengths.push(Number(m[1]) * per);
  }
  return { w: lengths[0]!, h: lengths[1]! };
}

export function parseDims(size: string): Dims {
  const dims = tryParseDims(size);
  if (!dims) throw new Error(`unknown size "${size}"`);
  return dims;
}

/** A size is a CSS named page size or "<length> <length>" (§4.3). */
export function isValidSize(value: string): boolean {
  return tryParseDims(value) !== null;
}

/** The unit a size reads back in — metric for named metric sheets and mm values. */
export function unitOf(size: string): Unit {
  const named = NAMED[size.trim().toLowerCase()];
  if (named) return named.unit;
  return /\d\s*(mm|cm)\b/.test(size) ? "mm" : "in";
}

const PLACES: Record<Unit, number> = { in: 3, mm: 2 };

/** Inches → a short display string in `unit`, trailing zeros dropped. */
export function fmtLength(inches: number, unit: Unit = "in"): string {
  const value = unit === "mm" ? inches * 25.4 : inches;
  return `${+value.toFixed(PLACES[unit])}${unit}`;
}

/**
 * Like fmtLength but never rounds up, so a size derived by dividing a sheet
 * still fits on it — rounding 74.25mm to 74.3mm would put four pages over the
 * edge of an A4 sheet and silently drop the setup to 2-up.
 */
function floorLength(inches: number, unit: Unit): string {
  const scale = 10 ** PLACES[unit];
  const value = unit === "mm" ? inches * 25.4 : inches;
  return `${Math.floor(value * scale + 1e-6) / scale}${unit}`;
}

export function fmtSize(d: Dims, unit: Unit = "in"): string {
  return `${fmtLength(d.w, unit)} ${fmtLength(d.h, unit)}`;
}

export function fmtDims(d: Dims): string {
  return `${+d.w.toFixed(2)}×${+d.h.toFixed(2)}in`;
}

export interface Grid {
  cols: number; // book pages across a sheet side; always even (2 per folio)
  rows: number; // rows of pages down the sheet, one folio per pair per row
  sheet: Dims; // the sheet in the orientation this grid lays out
}

const EPS = 1e-9; // "11/5.5" style exact fits must count

function gridIn(sheet: Dims, page: Dims): Grid | null {
  const across = Math.floor(sheet.w / page.w + EPS);
  const cols = across - (across % 2); // odd pages can't be folded into folios
  const rows = Math.floor(sheet.h / page.h + EPS);
  if (cols < 2 || rows < 1) return null;
  return { cols, rows, sheet };
}

/**
 * How book pages tile one side of a sheet (§7.7): `cols` across by `rows` down,
 * in whichever sheet orientation fits more of them. Null when two pages do not
 * fit either way.
 *
 * A row of pages is cut apart and each pair folded down its center, so rows > 1
 * means a horizontal cut before folding — the folds themselves stay vertical
 * and parallel to the spine, which is what §8 rules out changing.
 */
export function gridFor(sheet: Dims, page: Dims): Grid | null {
  const long = Math.max(sheet.w, sheet.h);
  const short = Math.min(sheet.w, sheet.h);
  const landscape = gridIn({ w: long, h: short }, page);
  const portrait = gridIn({ w: short, h: long }, page);
  if (!landscape) return portrait;
  if (!portrait) return landscape;
  // Ties go to the single-row landscape layout: fewer cuts, and it keeps every
  // setup that predates 2-D grids laid out exactly as it was.
  const gain = portrait.cols * portrait.rows - landscape.cols * landscape.rows;
  return gain > 0 ? portrait : landscape;
}

/** True when `grid` lays the sheet out with its long side across. */
export function isLandscape(grid: Grid): boolean {
  return grid.sheet.w >= grid.sheet.h;
}

// ---------- setup presets ----------

// A setup is a sheet plus the grid of book pages on one side of it: the page
// size follows from those, so the presets never carry stale arithmetic. Halving
// means one fold (2 × 1); quartering means one cut and two folds (2 × 2), which
// halves both sides of the sheet and so keeps its proportions.
interface SetupSpec {
  id: string;
  name: string;
  sheet: string;
  cols: number;
  rows: number;
}

const SETUP_SPECS: SetupSpec[] = [
  { id: "half-letter", name: "Half letter", sheet: "letter", cols: 2, rows: 1 },
  {
    id: "quarter-letter",
    name: "Quarter letter",
    sheet: "letter",
    cols: 2,
    rows: 2,
  },
  { id: "half-legal", name: "Half legal", sheet: "legal", cols: 2, rows: 1 },
  {
    id: "quarter-legal",
    name: "Quarter legal",
    sheet: "legal",
    cols: 2,
    rows: 2,
  },
  {
    id: "half-tabloid",
    name: "Half tabloid",
    sheet: "tabloid",
    cols: 2,
    rows: 1,
  },
  {
    id: "quarter-tabloid",
    name: "Quarter tabloid",
    sheet: "tabloid",
    cols: 2,
    rows: 2,
  },
  {
    id: "a3-folded",
    name: "A3 folded (A4 pages)",
    sheet: "A3",
    cols: 2,
    rows: 1,
  },
  {
    id: "a4-folded",
    name: "A4 folded (A5 pages)",
    sheet: "A4",
    cols: 2,
    rows: 1,
  },
  {
    id: "a4-quartered",
    name: "A4 quartered (A6 pages)",
    sheet: "A4",
    cols: 2,
    rows: 2,
  },
  {
    id: "a5-folded",
    name: "A5 folded (A6 pages)",
    sheet: "A5",
    cols: 2,
    rows: 1,
  },
];

export interface SetupPreset {
  id: string;
  label: string; // "Quarter legal — 4.25in × 7in, 4-up on legal (2 × 2)"
  sheet: string;
  size: string;
  cols: number;
  rows: number;
}

/**
 * The book page a sheet yields under a `cols` × `rows` grid. A single row runs
 * across the sheet's long side; stacked rows run down it, which is what makes a
 * quartered page a scaled-down sheet rather than a strip of one.
 */
export function pageForSheet(sheet: Dims, cols: number, rows: number): Dims {
  const long = Math.max(sheet.w, sheet.h);
  const short = Math.min(sheet.w, sheet.h);
  const [w, h] = rows === 1 ? [long, short] : [short, long];
  return { w: w / cols, h: h / rows };
}

function toPreset(spec: SetupSpec): SetupPreset {
  const unit = unitOf(spec.sheet);
  const leaf = pageForSheet(parseDims(spec.sheet), spec.cols, spec.rows);
  const size = `${floorLength(leaf.w, unit)} ${floorLength(leaf.h, unit)}`;
  const grid = spec.rows === 1 ? "" : ` (${spec.cols} × ${spec.rows})`;
  return {
    id: spec.id,
    label: `${spec.name} — ${size.replace(" ", " × ")}, ${
      spec.cols * spec.rows
    }-up on ${spec.sheet}${grid}`,
    sheet: spec.sheet,
    size,
    cols: spec.cols,
    rows: spec.rows,
  };
}

/** Every named setup, page size derived from its sheet (§4.3). */
export const SETUP_PRESETS: SetupPreset[] = SETUP_SPECS.map(toPreset);

/** The named setup a stored (size, sheet) pair is, or null when it is a custom one. */
export function setupPresetFor(
  size: string | undefined,
  sheet: string | undefined,
): SetupPreset | null {
  if (!size || !sheet) return null;
  const page = tryParseDims(size);
  const paper = tryParseDims(sheet);
  if (!page || !paper) return null;
  const EPS = 1e-6;
  return SETUP_PRESETS.find((p) => {
    const other = tryParseDims(p.sheet);
    if (!other || Math.abs(other.w - paper.w) > EPS) return false;
    if (Math.abs(other.h - paper.h) > EPS) return false;
    const want = tryParseDims(p.size)!;
    return Math.abs(want.w - page.w) < EPS && Math.abs(want.h - page.h) < EPS;
  }) ?? null;
}

// ---------- resolving a setup ----------

export const DEFAULT_SIZE = "5.5in 8.5in";
export const DEFAULT_SHEET = "letter";
export const DEFAULT_FOLIOS = 4;
export const DEFAULT_DUPLEX: Duplex = "short-edge";

export const DUPLEX_VALUES: readonly Duplex[] = [
  "short-edge",
  "long-edge",
  "none",
];

interface PageSetupCommon {
  // Configured values, with §4.3's defaults applied.
  size: string;
  sheet: string;
  folios: number;
  duplex: Duplex;
  unit: Unit;
  preset: SetupPreset | null;
  // Derived. All zero when the setup is unusable — callers show `error` instead.
  nUp: number; // book pages on one sheet side = cols × rows
  cols: number; // pages across the sheet
  rows: number; // rows of pages down it; > 1 means a cut before folding
  landscape: boolean; // whether the sheet prints with its long side across
  foliosPerSheet: number;
  cutsPerSheet: number;
  sheetsPerSignature: number;
  pagesPerSignature: number;
  slackAcross: number; // inches of sheet left over across the printed width
  slackDown: number; // inches left over down the printed height
}

/**
 * A resolved setup. `error === null` is the discriminant that guarantees the
 * geometry parsed and fits, so callers get non-null dimensions without a cast.
 */
export type PageSetup =
  | (PageSetupCommon & { error: null; page: Dims; sheetDims: Dims })
  | (PageSetupCommon & {
    error: string;
    page: Dims | null;
    sheetDims: Dims | null;
  });

const EMPTY = {
  nUp: 0,
  cols: 0,
  rows: 0,
  landscape: true,
  foliosPerSheet: 0,
  cutsPerSheet: 0,
  sheetsPerSignature: 0,
  pagesPerSignature: 0,
  slackAcross: 0,
  slackDown: 0,
};

/**
 * A `page` section plus per-run overrides (the `bml export` flags) resolved
 * into the full physical setup. Never throws: an unusable setup comes back
 * with `error` set so the config panel can render it inline.
 */
export function resolvePageSetup(
  page: PageConfig | undefined,
  overrides: {
    size?: string;
    sheet?: string;
    folios?: number;
    duplex?: Duplex;
  } = {},
): PageSetup {
  const size = overrides.size ?? page?.size ?? DEFAULT_SIZE;
  const sheet = overrides.sheet ?? page?.sheet ?? DEFAULT_SHEET;
  const folios = overrides.folios ?? page?.["folios-per-signature"] ??
    DEFAULT_FOLIOS;
  const duplex = overrides.duplex ?? page?.duplex ?? DEFAULT_DUPLEX;
  const unit = unitOf(size);
  const pageDims = tryParseDims(size);
  const sheetDims = tryParseDims(sheet);
  const base = {
    size,
    sheet,
    folios,
    duplex,
    unit,
    page: pageDims,
    sheetDims,
    preset: setupPresetFor(size, sheet),
  };
  const fail = (error: string): PageSetup => ({ ...base, ...EMPTY, error });

  if (!pageDims) return fail(`unknown page size "${size}"`);
  if (!sheetDims) return fail(`unknown sheet size "${sheet}"`);
  if (!Number.isInteger(folios) || folios < 1) {
    return fail(
      `folios-per-signature must be a whole number ≥ 1 (got ${folios})`,
    );
  }
  if (!DUPLEX_VALUES.includes(duplex)) {
    return fail(
      `duplex must be short-edge, long-edge, or none (got "${duplex}")`,
    );
  }
  const grid = gridFor(sheetDims, pageDims);
  if (!grid) {
    return fail(
      `a ${fmtDims(pageDims)} page does not fit two-up on a ${
        fmtDims(sheetDims)
      } sheet`,
    );
  }
  const { cols, rows } = grid;
  // One folio per column pair per row. The cut count is the same whichever way
  // the pieces are separated: (rows − 1) across plus rows × (cols/2 − 1) down.
  const foliosPerSheet = rows * (cols / 2);
  return {
    ...base,
    page: pageDims, // re-stated so the `error: null` branch keeps non-null dims
    sheetDims,
    error: null,
    nUp: cols * rows,
    cols,
    rows,
    landscape: isLandscape(grid),
    foliosPerSheet,
    cutsPerSheet: foliosPerSheet - 1,
    sheetsPerSignature: Math.ceil(folios / foliosPerSheet),
    pagesPerSignature: folios * 4,
    slackAcross: grid.sheet.w - cols * pageDims.w,
    slackDown: grid.sheet.h - rows * pageDims.h,
  };
}

/**
 * The one line that names a setup — edition picker, CLI, panel readout. Display
 * only: it stays short on a broken setup, where `error` carries the detail.
 */
export function describePageSetup(s: PageSetup): string {
  const size = s.size.replace(" ", " × ");
  if (s.page === null) return `${size} · unrecognized page size`;
  if (s.error !== null) return `${size} · will not print on ${s.sheet}`;
  return `${size} · ${s.nUp}-up on ${s.sheet}`;
}
