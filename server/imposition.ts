// server/imposition.ts — page → sheet imposition (spec §7.7). Pure; no I/O.
// All dimensions in inches. The geometry that the config panel also needs
// (sizes, the n-up grid) lives in metadata/page-setup.ts, re-exported here.
import {
  type Dims,
  fmtDims,
  gridFor,
  isLandscape,
} from "../metadata/page-setup.ts";
import type { Flip } from "../metadata/types.ts";

export { type Dims, fmtDims, gridFor };
export { parseDims } from "../metadata/page-setup.ts";

export type { Flip };

export interface ImposeConfig {
  folios: number; // folios per signature (§4.3)
  sheet: Dims;
  page: Dims;
  duplex: Flip | "none";
  flip: Flip; // back-side layout when duplex is "none"
  tail?: number; // trailing pages pinned to the end of the padded run (the colophon); the padding blanks go before them
}

export interface Slot {
  page: number | null; // 0-based global page index; null = blank
  rotate: 0 | 180;
  folio: number; // 1 = outermost in its signature
}

export interface Sheet {
  signature: number; // 0-based
  front: Slot[]; // row-major: slot i at column i % cols, row ⌊i / cols⌋
  back: Slot[];
}

export interface Imposition {
  nUp: number; // book pages per sheet side = cols × rows
  cols: number;
  rows: number;
  sheet: Dims; // the sheet in the orientation the grid lays out
  paddedCount: number;
  signatures: number;
  sheetsPerSignature: number;
  sheets: Sheet[];
  wastedFolioSlots: number; // blank folio slots per signature (cut halves that are waste)
}

export interface Side {
  label: string; // "sig 1 · sheet 2 · back"
  slots: Slot[];
}

/** Order the sheet sides for one print run: duplex interleaves fronts and
 * backs, fronts/backs are the two runs of a by-hand job. */
export function sidesFor(
  imp: Imposition,
  mode: "duplex" | "fronts" | "backs",
  reverseBacks: boolean,
): Side[] {
  const sides: Side[] = [];
  imp.sheets.forEach((sh, i) => {
    const n = (i % imp.sheetsPerSignature) + 1;
    const label = (face: string) =>
      `sig ${sh.signature + 1} · sheet ${n} · ${face}`;
    if (mode !== "backs") {
      sides.push({ label: label("front"), slots: sh.front });
    }
    if (mode !== "fronts") sides.push({ label: label("back"), slots: sh.back });
  });
  return mode === "backs" && reverseBacks ? sides.reverse() : sides;
}

export function impose(pageCount: number, cfg: ImposeConfig): Imposition {
  const grid = gridFor(cfg.sheet, cfg.page);
  if (!grid) {
    throw new Error(
      `page ${fmtDims(cfg.page)} does not fit 2-up on sheet ${
        fmtDims(cfg.sheet)
      }`,
    );
  }
  const { cols, rows } = grid;
  const P = 4 * cfg.folios; // pages per signature
  const paddedCount = Math.ceil(Math.max(pageCount, 1) / P) * P;
  const signatures = paddedCount / P;
  const foliosPerSheet = rows * (cols / 2);
  const sheetsPerSignature = Math.ceil(cfg.folios / foliosPerSheet);
  const flip: Flip = cfg.duplex === "none" ? cfg.flip : cfg.duplex;
  // Which way the sheet turns over decides which axis the back side mirrors:
  // turning about a left/right edge mirrors columns, about a top/bottom edge
  // mirrors rows. Those edges are the short ones on a landscape sheet and the
  // long ones on a portrait sheet, so the same `duplex` setting means opposite
  // things for a 2-up landscape job and a quartered portrait one.
  const mirrorCols = (flip === "short-edge") === isLandscape(grid);

  const tail = Math.min(cfg.tail ?? 0, pageCount);
  const slot = (sig: number, local: number, folio: number): Slot => {
    const g = sig * P + local - 1; // local is 1-based within the signature
    // The tail keeps the book's last pages last: the blanks pad before it.
    const page = g >= paddedCount - tail
      ? pageCount - (paddedCount - g)
      : g < pageCount - tail
      ? g
      : null;
    return { page, rotate: 0, folio };
  };
  const blank = (folio: number): Slot => ({ page: null, rotate: 0, folio });

  const sheets: Sheet[] = [];
  for (let sig = 0; sig < signatures; sig++) {
    for (let sh = 0; sh < sheetsPerSignature; sh++) {
      // Both sides are built row-major, so slot i sits at column i % cols of
      // row ⌊i / cols⌋ — one folio per column pair, rows stacked down the sheet.
      const front: Slot[] = [];
      const back: Slot[] = [];
      for (let r = 0; r < rows; r++) {
        const backPairs: Slot[][] = [];
        for (let j = 0; j < cols / 2; j++) {
          // folio number, 1 = outermost
          const k = sh * foliosPerSheet + r * (cols / 2) + j + 1;
          if (k > cfg.folios) {
            front.push(blank(k), blank(k));
            backPairs.push([blank(k), blank(k)]);
            continue;
          }
          // §7.7: folio k front [P−2k+2 | 2k−1], back [2k | P−2k+1]
          front.push(slot(sig, P - 2 * k + 2, k), slot(sig, 2 * k - 1, k));
          backPairs.push([slot(sig, 2 * k, k), slot(sig, P - 2 * k + 1, k)]);
        }
        // Mirroring the pair order within the row puts page 2k behind 2k−1,
        // each [2k | P−2k+1] pair left intact.
        back.push(...backPairs.reverse().flat());
      }
      // A row-mirroring turn is that same layout rotated 180° as a whole, which
      // row-major order makes a plain reverse of every slot.
      const backSide = mirrorCols
        ? back
        : back.reverse().map((s) => ({ ...s, rotate: 180 as const }));
      sheets.push({ signature: sig, front, back: backSide });
    }
  }
  return {
    nUp: cols * rows,
    cols,
    rows,
    sheet: grid.sheet,
    paddedCount,
    signatures,
    sheetsPerSignature,
    sheets,
    wastedFolioSlots: sheetsPerSignature * foliosPerSheet - cfg.folios,
  };
}
