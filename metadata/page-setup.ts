// metadata/page-setup.ts — the physical page setup (spec §4.3): the book page,
// the sheet it prints on, and everything the two together imply. Pure and
// dependency-free (no Deno APIs) so the config panel and the print exporter
// share one source of truth for this geometry.
import type { Duplex, Fold, PageConfig } from "./types.ts";

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
  cols: number; // book pages across a sheet side; even for every fold but leaves
  rows: number; // rows of pages down the sheet
  sheet: Dims; // the sheet in the orientation this grid lays out
}

const EPS = 1e-9; // "11/5.5" style exact fits must count

function gridIn(sheet: Dims, page: Dims, even = true): Grid | null {
  const across = Math.floor(sheet.w / page.w + EPS);
  const cols = even ? across - (across % 2) : across; // a folio takes two
  const rows = Math.floor(sheet.h / page.h + EPS);
  if (cols < (even ? 2 : 1) || rows < 1) return null;
  return { cols, rows, sheet };
}

// The grid in whichever sheet orientation fits more pages. Ties go to the
// single-row landscape layout: fewer cuts, and it keeps every setup that
// predates 2-D grids laid out exactly as it was.
function bestGrid(sheet: Dims, page: Dims, even: boolean): Grid | null {
  const long = Math.max(sheet.w, sheet.h);
  const short = Math.min(sheet.w, sheet.h);
  const landscape = gridIn({ w: long, h: short }, page, even);
  const portrait = gridIn({ w: short, h: long }, page, even);
  if (!landscape) return portrait;
  if (!portrait) return landscape;
  const gain = portrait.cols * portrait.rows - landscape.cols * landscape.rows;
  return gain > 0 ? portrait : landscape;
}

/**
 * How book pages tile one side of a sheet that is cut before folding (§7.7,
 * fold "cut"): `cols` across by `rows` down, in whichever sheet orientation
 * fits more of them. Null when two pages do not fit either way.
 *
 * A row of pages is cut apart and each pair folded down its center, so rows > 1
 * means a horizontal cut before folding.
 */
export function gridFor(sheet: Dims, page: Dims): Grid | null {
  return bestGrid(sheet, page, true);
}

/**
 * The folds that make a whole sheet into one gathering (§7.7), in order. Each
 * halves the paper: "v" takes the left half back behind the right, "h" the top
 * half back behind the bottom. The last is always "v", the spine. `cols` ×
 * `rows` is the grid of pages the folds divide the sheet into, laid out with
 * the sheet's long side across when `landscape`.
 */
export const TRUE_FOLDS = {
  folio: { cols: 2, rows: 1, landscape: true, folds: ["v"] },
  quarto: { cols: 2, rows: 2, landscape: false, folds: ["h", "v"] },
  octavo: { cols: 4, rows: 2, landscape: true, folds: ["v", "h", "v"] },
} as const satisfies Record<
  string,
  {
    cols: number;
    rows: number;
    landscape: boolean;
    folds: readonly ("v" | "h")[];
  }
>;

export type TrueFold = keyof typeof TRUE_FOLDS;
export const isTrueFold = (f: Fold): f is TrueFold => f in TRUE_FOLDS;

export const FOLD_VALUES: readonly Fold[] = [
  "folio",
  "quarto",
  "octavo",
  "cut",
  "leaves",
];

/** The grid a fold prints `page` in on `sheet`, or null when it does not fit. */
export function gridForFold(fold: Fold, sheet: Dims, page: Dims): Grid | null {
  if (fold === "cut") return gridFor(sheet, page);
  if (fold === "leaves") return bestGrid(sheet, page, false);
  const f = TRUE_FOLDS[fold];
  const long = Math.max(sheet.w, sheet.h);
  const short = Math.min(sheet.w, sheet.h);
  const oriented = f.landscape ? { w: long, h: short } : { w: short, h: long };
  // Folding halves the paper, so each page gets an equal cell of the sheet.
  const fits = page.w <= oriented.w / f.cols + EPS &&
    page.h <= oriented.h / f.rows + EPS;
  return fits ? { cols: f.cols, rows: f.rows, sheet: oriented } : null;
}

/**
 * With no fold set: the one that puts the most pages on a sheet, a true fold
 * winning a tie with cut-then-fold (a quartered sheet folds as a real quarto).
 * Loose leaves are never picked; they are a binding choice, not a geometry.
 */
export function autoFold(
  sheet: Dims,
  page: Dims,
): { fold: Fold; grid: Grid } | null {
  let best: { fold: Fold; grid: Grid } | null = null;
  for (const fold of ["octavo", "quarto", "folio", "cut"] as const) {
    const grid = gridForFold(fold, sheet, page);
    if (
      grid && (!best || grid.cols * grid.rows > best.grid.cols * best.grid.rows)
    ) {
      best = { fold, grid };
    }
  }
  return best;
}

/** True when `grid` lays the sheet out with its long side across. */
export function isLandscape(grid: Grid): boolean {
  return grid.sheet.w >= grid.sheet.h;
}

// ---------- folded sizes ----------

/**
 * The book page a sheet yields under a `cols` × `rows` grid, as a size string.
 * A single row runs across the sheet's long side; stacked rows run down it,
 * which is what makes a quartered page a scaled-down sheet rather than a strip
 * of one — legal 8.5in × 14in quarters to 4.25in × 7in.
 *
 * Never rounds up, so a size derived by dividing a sheet still fits on it:
 * rounding 74.25mm to 74.3mm would put four pages over the edge of an A4 sheet.
 */
export function foldedSize(sheet: string, cols: number, rows: number): string {
  const dims = parseDims(sheet);
  const unit = unitOf(sheet);
  const long = Math.max(dims.w, dims.h);
  const short = Math.min(dims.w, dims.h);
  const [w, h] = rows === 1 ? [long, short] : [short, long];
  return `${floorLength(w / cols, unit)} ${floorLength(h / rows, unit)}`;
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
  folios: number; // a booklet's is its page count ÷ 4; true folds round up to whole sheets
  booklet: boolean; // every page in one signature
  fold: Fold; // the fold in use: the configured one, or autoFold's pick
  autoFold: boolean; // no fold configured; `fold` is the pick
  duplex: Duplex;
  unit: Unit;
  // Derived. All zero when the setup is unusable — callers show `error` instead.
  nUp: number; // book pages on one sheet side = cols × rows
  cols: number; // pages across the sheet
  rows: number; // rows of pages down it
  landscape: boolean; // whether the sheet prints with its long side across
  foliosPerSheet: number; // 0 for loose leaves
  cutsPerSheet: number; // before folding; a true fold has none (it is slit after)
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
    folios?: number | "booklet";
    fold?: Fold;
    duplex?: Duplex;
    pageCount?: number; // sizes a booklet and loose leaves; until known, one sheet's worth
  } = {},
): PageSetup {
  const size = overrides.size ?? page?.size ?? DEFAULT_SIZE;
  const sheet = overrides.sheet ?? page?.sheet ?? DEFAULT_SHEET;
  const setting = overrides.folios ?? page?.["folios-per-signature"] ??
    DEFAULT_FOLIOS;
  const booklet = setting === "booklet";
  let folios = booklet
    ? Math.max(1, Math.ceil((overrides.pageCount ?? 0) / 4))
    : setting;
  const configuredFold = overrides.fold ?? page?.fold;
  const duplex = overrides.duplex ?? page?.duplex ?? DEFAULT_DUPLEX;
  const unit = unitOf(size);
  const pageDims = tryParseDims(size);
  const sheetDims = tryParseDims(sheet);
  const base = {
    size,
    sheet,
    folios,
    booklet,
    fold: configuredFold ?? "cut",
    autoFold: configuredFold === undefined,
    duplex,
    unit,
    page: pageDims,
    sheetDims,
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
  if (configuredFold !== undefined && !FOLD_VALUES.includes(configuredFold)) {
    return fail(
      `fold must be ${FOLD_VALUES.join(", ")} (got "${configuredFold}")`,
    );
  }
  const picked = configuredFold === undefined
    ? autoFold(sheetDims, pageDims)
    : (() => {
      const grid = gridForFold(configuredFold, sheetDims, pageDims);
      return grid && { fold: configuredFold, grid };
    })();
  if (!picked) {
    return fail(
      configuredFold === undefined || configuredFold === "cut"
        ? `a ${fmtDims(pageDims)} page does not fit two-up on a ${
          fmtDims(sheetDims)
        } sheet`
        : configuredFold === "leaves"
        ? `a ${fmtDims(pageDims)} page does not fit on a ${
          fmtDims(sheetDims)
        } sheet`
        : `a ${fmtDims(pageDims)} page does not fit ${
          configuredFold === "octavo" ? "an" : "a"
        } ${configuredFold} of a ${fmtDims(sheetDims)} sheet`,
    );
  }
  const { fold, grid } = picked;
  const { cols, rows } = grid;
  const nUp = cols * rows;
  let foliosPerSheet = nUp / 2; // one folio per page pair
  let sheetsPerSignature: number;
  let pagesPerSignature: number;
  let cutsPerSheet: number;
  if (fold === "leaves") {
    // No folios: every page pair is its own leaf, cut and stacked.
    foliosPerSheet = 0;
    const leaves = Math.ceil((overrides.pageCount || 2 * nUp) / 2);
    sheetsPerSignature = Math.ceil(leaves / nUp);
    pagesPerSignature = 2 * nUp * sheetsPerSignature;
    cutsPerSheet = nUp - 1;
  } else if (isTrueFold(fold)) {
    // A folded sheet nests whole: round the signature up to whole sheets.
    folios = Math.ceil(folios / foliosPerSheet) * foliosPerSheet;
    sheetsPerSignature = folios / foliosPerSheet;
    pagesPerSignature = folios * 4;
    cutsPerSheet = 0;
  } else {
    // The cut count is the same whichever way the pieces are separated:
    // (rows − 1) across plus rows × (cols/2 − 1) down.
    sheetsPerSignature = Math.ceil(folios / foliosPerSheet);
    pagesPerSignature = folios * 4;
    cutsPerSheet = foliosPerSheet - 1;
  }
  return {
    ...base,
    folios,
    fold,
    page: pageDims, // re-stated so the `error: null` branch keeps non-null dims
    sheetDims,
    error: null,
    nUp,
    cols,
    rows,
    landscape: isLandscape(grid),
    foliosPerSheet,
    cutsPerSheet,
    sheetsPerSignature,
    pagesPerSignature,
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
  if (isTrueFold(s.fold)) return `${size} · ${s.fold} on ${s.sheet}`;
  if (s.fold === "leaves") return `${size} · ${s.nUp}-up leaves on ${s.sheet}`;
  return `${size} · ${s.nUp}-up on ${s.sheet}`;
}
