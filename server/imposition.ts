// server/imposition.ts — page → sheet imposition (spec §7.7). Pure; no I/O.
// All dimensions in inches. The geometry that the config panel also needs
// (sizes, the n-up grid) lives in metadata/page-setup.ts, re-exported here.
import {
  type Dims,
  fmtDims,
  gridFor,
  gridForFold,
  isLandscape,
  isTrueFold,
  TRUE_FOLDS,
} from "../metadata/page-setup.ts";
import type { Flip, Fold } from "../metadata/types.ts";
import type { SheetMarks, SideMarks } from "./marks.ts";

export { type Dims, fmtDims, gridFor };
export { parseDims } from "../metadata/page-setup.ts";

export type { Flip, Fold };

export interface ImposeConfig {
  folios: number; // folios per signature (§4.3); a true fold's is whole sheets
  sheet: Dims;
  page: Dims;
  fold?: Fold; // resolved, never auto; default "cut"
  duplex: Flip | "none";
  flip: Flip; // back-side layout when duplex is "none"
  tail?: number; // trailing pages pinned to the end of the padded run (the colophon); the padding blanks go before them
}

export interface Slot {
  page: number | null; // 0-based global page index; null = blank
  rotate: 0 | 180;
  folio: number; // 1 = outermost in its signature; 0 for a loose leaf
  x: number; // the page's top-left corner on its side as printed, inches
  y: number;
  centre?: boolean; // its signature's centre recto, where the sewing stations go
}

export interface Sheet {
  signature: number; // 0-based
  front: Slot[]; // row-major: slot i at column i % cols, row ⌊i / cols⌋
  back: Slot[];
}

export interface Imposition {
  fold: Fold;
  nUp: number; // book pages per sheet side = cols × rows
  cols: number;
  rows: number;
  sheet: Dims; // the sheet in the orientation the grid lays out
  cell: Dims; // one grid cell: the page when cut, a share of the sheet when folded
  origin: { x: number; y: number }; // the grid's top-left on the sheet
  paddedCount: number;
  signatures: number;
  sheetsPerSignature: number;
  sheets: Sheet[];
  wastedFolioSlots: number; // blank folio slots per signature (cut halves that are waste)
}

export interface Side {
  label: string; // "sig 1 · sheet 2 · back"
  slots: Slot[];
  marks: SideMarks; // this face's binding marks (server/marks.ts)
}

/** Order the sheet sides for one print run: duplex interleaves fronts and
 * backs, fronts/backs are the two runs of a by-hand job. */
export function sidesFor(
  imp: Imposition,
  mode: "duplex" | "fronts" | "backs",
  reverseBacks: boolean,
  sheetMarks: SheetMarks[] = [],
): Side[] {
  const sides: Side[] = [];
  imp.sheets.forEach((sh, i) => {
    const n = (i % imp.sheetsPerSignature) + 1;
    const label = (face: string) =>
      `sig ${sh.signature + 1} · sheet ${n} · ${face}`;
    const marks = (face: "front" | "back") =>
      sheetMarks[i]?.[face] ?? { dots: [], lines: [] };
    if (mode !== "backs") {
      sides.push({
        label: label("front"),
        slots: sh.front,
        marks: marks("front"),
      });
    }
    if (mode !== "fronts") {
      sides.push({
        label: label("back"),
        slots: sh.back,
        marks: marks("back"),
      });
    }
  });
  return mode === "backs" && reverseBacks ? sides.reverse() : sides;
}

type Unplaced = Omit<Slot, "x" | "y"> & { recto: boolean };

/**
 * One sheet folded whole (spec §7.7): where each of its 2 × cols × rows local
 * pages (0-based, reading order) lands. Simulates the folds — each takes one
 * half back behind the other, flipping it — then reads the stack front to
 * back as leaves: layer i carries pages 2i (facing) and 2i + 1 (away). Front
 * is row-major as printed; back is row-major as printed after the sheet turns
 * about a left/right edge, so the slot behind front slot (c, r) is (cols−1−c, r).
 */
export function foldedSheet(
  folds: readonly ("v" | "h")[],
  cols: number,
  rows: number,
): {
  front: Array<{ page: number; rotate: 0 | 180 }>;
  back: Array<{ page: number; rotate: 0 | 180 }>;
} {
  // A cell's front face is `up` (toward the viewer) or not; sx/sy say whether
  // its printed x/y axes still point the way they did on the flat sheet.
  interface Cell {
    i: number;
    up: boolean;
    sx: 1 | -1;
    sy: 1 | -1;
  }
  let w = cols;
  let h = rows;
  let stacks = new Map<string, Cell[]>();
  for (let i = 0; i < cols * rows; i++) {
    stacks.set(`${i % cols},${Math.floor(i / cols)}`, [
      { i, up: true, sx: 1, sy: 1 },
    ]);
  }
  for (const f of folds) {
    const stay = new Map<string, Cell[]>();
    const moved = new Map<string, Cell[]>();
    for (const [key, stack] of stacks) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (f === "v" ? x >= w / 2 : y >= h / 2) {
        stay.set(f === "v" ? `${x - w / 2},${y}` : `${x},${y - h / 2}`, stack);
      } else {
        // The half going back lands mirrored, its stack reversed and flipped.
        moved.set(
          f === "v" ? `${w / 2 - 1 - x},${y}` : `${x},${h / 2 - 1 - y}`,
          stack.toReversed().map((c) => ({
            ...c,
            up: !c.up,
            sx: f === "v" ? -c.sx as 1 | -1 : c.sx,
            sy: f === "h" ? -c.sy as 1 | -1 : c.sy,
          })),
        );
      }
    }
    stacks = new Map([...stay].map(([k, v]) => [k, [...v, ...moved.get(k)!]]));
    if (f === "v") w /= 2;
    else h /= 2;
  }
  const stack = stacks.get("0,0");
  if (w !== 1 || h !== 1 || !stack) {
    throw new Error(
      `folds ${folds.join("")} do not reduce ${cols}×${rows} to one page`,
    );
  }
  const front: Array<{ page: number; rotate: 0 | 180 }> = [];
  const back: typeof front = [];
  stack.forEach((c, layer) => {
    // Seen upright, a face is a rotation of the flat sheet; a face turned away
    // is seen after the leaf turns over the spine, which mirrors x once more.
    // Front and back of one cell come out the same, back in its own frame.
    const sx = c.up ? c.sx : -c.sx;
    if (sx !== c.sy) {
      throw new Error(`folds ${folds.join("")} leave a page sideways`);
    }
    const rotate = sx === 1 ? 0 : 180;
    const col = c.i % cols;
    const row = Math.floor(c.i / cols);
    front[c.i] = { page: c.up ? 2 * layer : 2 * layer + 1, rotate };
    back[row * cols + cols - 1 - col] = {
      page: c.up ? 2 * layer + 1 : 2 * layer,
      rotate,
    };
  });
  return { front, back };
}

export function impose(pageCount: number, cfg: ImposeConfig): Imposition {
  const fold = cfg.fold ?? "cut";
  const grid = gridForFold(fold, cfg.sheet, cfg.page);
  if (!grid) {
    throw new Error(
      `page ${fmtDims(cfg.page)} does not fit ${
        fold === "cut" ? "2-up" : `${fold === "octavo" ? "an" : "a"} ${fold}`
      } on sheet ${fmtDims(cfg.sheet)}`,
    );
  }
  const { cols, rows } = grid;
  const flip: Flip = cfg.duplex === "none" ? cfg.flip : cfg.duplex;
  // Which way the sheet turns over decides which axis the back side mirrors:
  // turning about a left/right edge mirrors columns, about a top/bottom edge
  // mirrors rows. Those edges are the short ones on a landscape sheet and the
  // long ones on a portrait sheet, so the same `duplex` setting means opposite
  // things for a 2-up landscape job and a quartered portrait one.
  const mirrorCols = (flip === "short-edge") === isLandscape(grid);
  // Backs are built for a left/right turn; a top/bottom turn is that same
  // layout rotated 180° as a whole, which row-major order makes a plain reverse.
  const turn = (back: Unplaced[]) =>
    mirrorCols ? back : back.toReversed().map((s) => ({
      ...s,
      rotate: (s.rotate ? 0 : 180) as 0 | 180,
    }));

  const sheets: Array<
    { signature: number; front: Unplaced[]; back: Unplaced[] }
  > = [];
  let paddedCount: number;
  let signatures: number;
  let sheetsPerSignature: number;
  let wastedFolioSlots = 0;

  if (fold === "leaves") {
    // Cut and stack: slot s of sheet t carries leaf s·N + t, so cutting the
    // printed stack into its N-high piles and stacking the piles in slot order
    // gives the leaves in order. A leaf's front is its recto.
    const n = cols * rows;
    const leaves = Math.ceil(Math.max(pageCount, 1) / 2);
    const N = Math.ceil(leaves / n);
    const page = (g: number) => (g < pageCount ? g : null);
    for (let t = 0; t < N; t++) {
      const front: Unplaced[] = [];
      const back: Unplaced[] = [];
      for (let s = 0; s < n; s++) {
        const leaf = s * N + t;
        front.push({ page: page(2 * leaf), rotate: 0, folio: 0, recto: true });
        back[Math.floor(s / cols) * cols + cols - 1 - (s % cols)] = {
          page: page(2 * leaf + 1),
          rotate: 0,
          folio: 0,
          recto: false,
        };
      }
      sheets.push({ signature: 0, front, back: turn(back) });
    }
    paddedCount = 2 * n * N;
    signatures = 1;
    sheetsPerSignature = N;
  } else {
    const P = 4 * cfg.folios; // pages per signature
    paddedCount = Math.ceil(Math.max(pageCount, 1) / P) * P;
    signatures = paddedCount / P;
    const tail = Math.min(cfg.tail ?? 0, pageCount);
    // local: 0-based within the signature.
    const slot = (sig: number, local: number): Unplaced => {
      const g = sig * P + local;
      // The tail keeps the book's last pages last: the blanks pad before it.
      const page = g >= paddedCount - tail
        ? pageCount - (paddedCount - g)
        : g < pageCount - tail
        ? g
        : null;
      const folio = Math.floor(Math.min(local, P - 1 - local) / 2) + 1;
      return {
        page,
        rotate: 0,
        folio,
        recto: local % 2 === 0,
        centre: local === P / 2,
      };
    };

    if (isTrueFold(fold)) {
      // Each folded sheet is a run of leaves nested whole: the outermost
      // sheet carries the signature's first L leaves and its last L.
      const L = cols * rows; // leaves per folded sheet
      const one = foldedSheet(TRUE_FOLDS[fold].folds, cols, rows);
      sheetsPerSignature = P / (2 * L);
      if (!Number.isInteger(sheetsPerSignature)) {
        throw new Error(
          `a ${fold} signature takes whole sheets: folios must be a multiple of ${
            L / 2
          }`,
        );
      }
      for (let sig = 0; sig < signatures; sig++) {
        for (let sh = 0; sh < sheetsPerSignature; sh++) {
          const at = (t: { page: number; rotate: 0 | 180 }) => ({
            ...slot(
              sig,
              t.page < L ? sh * L + t.page : P - 2 * L + t.page - sh * L,
            ),
            rotate: t.rotate,
          });
          sheets.push({
            signature: sig,
            front: one.front.map(at),
            back: turn(one.back.map(at)),
          });
        }
      }
    } else {
      const foliosPerSheet = rows * (cols / 2);
      sheetsPerSignature = Math.ceil(cfg.folios / foliosPerSheet);
      wastedFolioSlots = sheetsPerSignature * foliosPerSheet - cfg.folios;
      const blank = (folio: number): Unplaced => ({
        page: null,
        rotate: 0,
        folio,
        recto: false,
      });
      for (let sig = 0; sig < signatures; sig++) {
        for (let sh = 0; sh < sheetsPerSignature; sh++) {
          // Both sides are built row-major, so slot i sits at column i % cols
          // of row ⌊i / cols⌋ — one folio per column pair, rows stacked down.
          const front: Unplaced[] = [];
          const back: Unplaced[] = [];
          for (let r = 0; r < rows; r++) {
            const backPairs: Unplaced[][] = [];
            for (let j = 0; j < cols / 2; j++) {
              // folio number, 1 = outermost
              const k = sh * foliosPerSheet + r * (cols / 2) + j + 1;
              if (k > cfg.folios) {
                front.push(blank(k), blank(k));
                backPairs.push([blank(k), blank(k)]);
                continue;
              }
              // §7.7: folio k front [P−2k+2 | 2k−1], back [2k | P−2k+1] (1-based)
              front.push(slot(sig, P - 2 * k + 1), slot(sig, 2 * k - 2));
              backPairs.push([slot(sig, 2 * k - 1), slot(sig, P - 2 * k)]);
            }
            // Mirroring the pair order within the row puts page 2k behind
            // 2k−1, each [2k | P−2k+1] pair left intact.
            back.push(...backPairs.reverse().flat());
          }
          sheets.push({ signature: sig, front, back: turn(back) });
        }
      }
    }
  }

  // Where each page sits. Cut sheets and leaves pack the pages edge to edge,
  // centred. A folded sheet folds at its own halves, so each page gets an equal
  // cell and sits against the spine edge of it — a recto's left, a verso's
  // right, swapped when printed upside down — centred head to tail; the rest
  // is trimmed off the fore edge, head and tail.
  const { w: W, h: H } = grid.sheet;
  const { w: pw, h: ph } = cfg.page;
  const folded = isTrueFold(fold);
  const cell = folded ? { w: W / cols, h: H / rows } : { w: pw, h: ph };
  const origin = folded
    ? { x: 0, y: 0 }
    : { x: (W - cols * pw) / 2, y: (H - rows * ph) / 2 };
  const place = (slots: Unplaced[]): Slot[] =>
    slots.map(({ recto, ...s }, i) => {
      const x = origin.x + (i % cols) * cell.w;
      const y = origin.y + Math.floor(i / cols) * cell.h;
      if (!folded) return { ...s, x, y };
      const spineLeft = recto !== (s.rotate === 180);
      return {
        ...s,
        x: spineLeft ? x : x + cell.w - pw,
        y: y + (cell.h - ph) / 2,
      };
    });

  return {
    fold,
    nUp: cols * rows,
    cols,
    rows,
    sheet: grid.sheet,
    cell,
    origin,
    paddedCount,
    signatures,
    sheetsPerSignature,
    sheets: sheets.map((sh) => ({
      signature: sh.signature,
      front: place(sh.front),
      back: place(sh.back),
    })),
    wastedFolioSlots,
  };
}
