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
  const toIn = (v: string, unit: string) =>
    unit === "mm" ? Number(v) / 25.4 : Number(v);
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

export type Flip = "short-edge" | "long-edge";

export interface ImposeConfig {
  folios: number; // folios per signature (§4.9)
  sheet: Dims;
  page: Dims;
  duplex: Flip | "none";
  flip: Flip; // back-side layout when duplex is "none"
}

export interface Slot {
  page: number | null; // 0-based global page index; null = blank
  rotate: 0 | 180;
  folio: number; // 1 = outermost in its signature
}

export interface Sheet {
  signature: number; // 0-based
  front: Slot[]; // left → right, 2 slots per folio
  back: Slot[];
}

export interface Imposition {
  nUp: number;
  paddedCount: number;
  signatures: number;
  sheetsPerSignature: number;
  sheets: Sheet[];
  wastedFolioSlots: number; // blank folio slots per signature (cut halves that are waste)
}

export function impose(pageCount: number, cfg: ImposeConfig): Imposition {
  const n = nUp(cfg.sheet, cfg.page);
  if (n < 2) {
    throw new Error(
      `page ${fmtDims(cfg.page)} does not fit 2-up on sheet ${
        fmtDims(cfg.sheet)
      }`,
    );
  }
  const P = 4 * cfg.folios; // pages per signature
  const paddedCount = Math.ceil(Math.max(pageCount, 1) / P) * P;
  const signatures = paddedCount / P;
  const foliosPerSheet = n / 2;
  const sheetsPerSignature = Math.ceil(cfg.folios / foliosPerSheet);
  const flip: Flip = cfg.duplex === "none" ? cfg.flip : cfg.duplex;

  const slot = (sig: number, local: number, folio: number): Slot => {
    const g = sig * P + local - 1; // local is 1-based within the signature
    return { page: g < pageCount ? g : null, rotate: 0, folio };
  };
  const blank = (folio: number): Slot => ({ page: null, rotate: 0, folio });

  const sheets: Sheet[] = [];
  for (let sig = 0; sig < signatures; sig++) {
    for (let sh = 0; sh < sheetsPerSignature; sh++) {
      const front: Slot[] = [];
      const backPairs: Slot[][] = [];
      for (let j = 0; j < foliosPerSheet; j++) {
        const k = sh * foliosPerSheet + j + 1; // folio number, 1 = outermost
        if (k > cfg.folios) {
          front.push(blank(k), blank(k));
          backPairs.push([blank(k), blank(k)]);
          continue;
        }
        // §7.7: folio k front [P−2k+2 | 2k−1], back [2k | P−2k+1]
        front.push(slot(sig, P - 2 * k + 2, k), slot(sig, 2 * k - 1, k));
        backPairs.push([slot(sig, 2 * k, k), slot(sig, P - 2 * k + 1, k)]);
      }
      // Book-style turn (short-edge on a landscape page): folio columns mirror,
      // each pair stays [2k | P−2k+1] so page 2k lands behind page 2k−1.
      let back = backPairs.reverse().flat();
      // Calendar-style turn (long-edge): the whole back side is rotated 180°.
      if (flip === "long-edge") {
        back = back.reverse().map((s) => ({ ...s, rotate: 180 }));
      }
      sheets.push({ signature: sig, front, back });
    }
  }
  return {
    nUp: n,
    paddedCount,
    signatures,
    sheetsPerSignature,
    sheets,
    wastedFolioSlots: sheetsPerSignature * foliosPerSheet - cfg.folios,
  };
}
