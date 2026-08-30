// server/imposition.ts — page → sheet imposition (spec §7.7). Pure; no I/O.
// All dimensions in inches.

export interface Dims {
  w: number;
  h: number;
}

const NAMED: Record<string, Dims> = {
  letter: { w: 8.5, h: 11 },
  legal: { w: 8.5, h: 14 },
  tabloid: { w: 11, h: 17 },
  a3: { w: 11.69, h: 16.54 },
  a4: { w: 8.27, h: 11.69 },
  a5: { w: 5.83, h: 8.27 },
};

/** "legal" | "5.25in 8in" | "148mm 210mm" → inches. Same value space as CSS `size:` (§4.3). */
export function parseDims(size: string): Dims {
  const named = NAMED[size.trim().toLowerCase()];
  if (named) return named;
  const m = size.trim().match(/^([\d.]+)(in|mm)\s+([\d.]+)(in|mm)$/);
  if (!m) throw new Error(`unknown size "${size}"`);
  const toIn = (v: string, unit: string) => unit === "mm" ? Number(v) / 25.4 : Number(v);
  return { w: toIn(m[1]!, m[2]!), h: toIn(m[3]!, m[4]!) }; // regex guarantees groups
}

export function fmtDims(d: Dims): string {
  return `${+d.w.toFixed(2)}×${+d.h.toFixed(2)}in`;
}

/** Largest even n with n·page.w ≤ sheet long side and page.h ≤ sheet short side; 0 if none. */
export function nUp(sheet: Dims, page: Dims): number {
  const long = Math.max(sheet.w, sheet.h);
  const short = Math.min(sheet.w, sheet.h);
  const EPS = 1e-9; // "11/5.5" style exact fits must count
  if (page.h > short + EPS) return 0;
  const n = Math.floor(long / page.w + EPS);
  return n - (n % 2);
}
