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

/**
 * Book pages across one sheet side: the largest even n with n·page.w ≤ the
 * sheet's long side and page.h ≤ its short side (§7.7). 0 when none fits.
 */
export function nUp(sheet: Dims, page: Dims): number {
  const long = Math.max(sheet.w, sheet.h);
  const short = Math.min(sheet.w, sheet.h);
  const EPS = 1e-9; // "11/5.5" style exact fits must count
  if (page.h > short + EPS) return 0;
  const n = Math.floor(long / page.w + EPS);
  return n - (n % 2);
}

// ---------- setup presets ----------

// A setup is a sheet plus how many book pages sit across one side of it: the
// page size follows from those two, so the presets never carry stale arithmetic.
// Only even counts are meaningful (§7.7: n/2 folios per sheet).
interface SetupSpec {
  id: string;
  name: string;
  sheet: string;
  across: number;
}

const SETUP_SPECS: SetupSpec[] = [
  { id: "half-letter", name: "Half letter", sheet: "letter", across: 2 },
  { id: "quarter-letter", name: "Quarter letter", sheet: "letter", across: 4 },
  { id: "half-legal", name: "Half legal", sheet: "legal", across: 2 },
  { id: "quarter-legal", name: "Quarter legal", sheet: "legal", across: 4 },
  { id: "half-tabloid", name: "Half tabloid", sheet: "tabloid", across: 2 },
  {
    id: "quarter-tabloid",
    name: "Quarter tabloid",
    sheet: "tabloid",
    across: 4,
  },
  { id: "a3-folded", name: "A3 folded (A4 pages)", sheet: "A3", across: 2 },
  { id: "a4-folded", name: "A4 folded (A5 pages)", sheet: "A4", across: 2 },
  { id: "a4-quartered", name: "A4 quartered", sheet: "A4", across: 4 },
  { id: "a5-folded", name: "A5 folded (A6 pages)", sheet: "A5", across: 2 },
];

export interface SetupPreset {
  id: string;
  label: string; // "Quarter legal — 3.5in × 8.5in, 4-up on legal"
  sheet: string;
  size: string;
  across: number;
}

/** The book page a sheet yields when `across` of them sit side by side. */
export function pageForSheet(sheet: Dims, across: number): Dims {
  return {
    w: Math.max(sheet.w, sheet.h) / across,
    h: Math.min(sheet.w, sheet.h),
  };
}

function toPreset(spec: SetupSpec): SetupPreset {
  const unit = unitOf(spec.sheet);
  const leaf = pageForSheet(parseDims(spec.sheet), spec.across);
  const size = `${floorLength(leaf.w, unit)} ${floorLength(leaf.h, unit)}`;
  return {
    id: spec.id,
    label: `${spec.name} — ${
      size.replace(" ", " × ")
    }, ${spec.across}-up on ${spec.sheet}`,
    sheet: spec.sheet,
    size,
    across: spec.across,
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
  nUp: number; // book pages across one sheet side
  foliosPerSheet: number;
  cutsPerSheet: number;
  sheetsPerSignature: number;
  pagesPerSignature: number;
  slackAcross: number; // inches of sheet left over across the long side
  slackDown: number; // inches left over down the short side
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
  const n = nUp(sheetDims, pageDims);
  if (n < 2) {
    return fail(
      `a ${fmtDims(pageDims)} page does not fit two-up on a ${
        fmtDims(sheetDims)
      } sheet`,
    );
  }
  const foliosPerSheet = n / 2;
  return {
    ...base,
    page: pageDims, // re-stated so the `error: null` branch keeps non-null dims
    sheetDims,
    error: null,
    nUp: n,
    foliosPerSheet,
    cutsPerSheet: foliosPerSheet - 1,
    sheetsPerSignature: Math.ceil(folios / foliosPerSheet),
    pagesPerSignature: folios * 4,
    slackAcross: Math.max(sheetDims.w, sheetDims.h) - n * pageDims.w,
    slackDown: Math.min(sheetDims.w, sheetDims.h) - pageDims.h,
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
