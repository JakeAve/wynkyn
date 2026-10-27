// server/marks.ts — binding marks on the imposed sheets (spec §7.7). Pure; no
// I/O, the client imports it. Every mark is in inches in its sheet side's
// printed frame (Slot.x/y's: origin top-left, y down), so both renderers only
// draw the list.
import { isTrueFold, TRUE_FOLDS } from "../metadata/page-setup.ts";
import type { ResolvedMarks } from "../metadata/page-setup.ts";
import type { Dims, Imposition } from "./imposition.ts";

export interface MarkDot {
  x: number;
  y: number;
}

export interface MarkLine {
  kind: "fold" | "cut";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SideMarks {
  dots: MarkDot[];
  lines: MarkLine[];
}

export interface SheetMarks {
  front: SideMarks;
  back: SideMarks;
}

// Points: dot is a diameter, line a stroke width, dash the fold lines' pattern.
export const MARK_STYLE = { grey: 0.5, dot: 1, line: 0.25, dash: [2, 3] };
// Inches: home printers can't print this close to the sheet edge.
export const DEAD_ZONE = 0.2;
const TICK = 0.25; // a cut tick's length, inches

/** Every mark on every sheet face, one entry per `imp.sheets[i]`. */
export function marksFor(
  imp: Imposition,
  page: Dims,
  marks: ResolvedMarks | null,
): SheetMarks[] {
  const { w: W, h: H } = imp.sheet;
  const { fold, cols, rows, origin } = imp;
  const clampX = (x: number) => Math.min(Math.max(x, DEAD_ZONE), W - DEAD_ZONE);
  const clampY = (y: number) => Math.min(Math.max(y, DEAD_ZONE), H - DEAD_ZONE);
  const foldLine = (x1: number, y1: number, x2: number, y2: number) => ({
    kind: "fold" as const,
    x1: clampX(x1),
    y1: clampY(y1),
    x2: clampX(x2),
    y2: clampY(y2),
  });

  // The same on every sheet's front: folds and cuts don't depend on pages.
  const front: MarkLine[] = [];
  if (marks?.folds && isTrueFold(fold)) {
    // Each fold takes a half behind the rest (foldedSheet), so what still faces
    // the folder is printed-front-up: every line is on the front, across only
    // the region the folds before it left — "v" keeps the right half, "h" the
    // bottom.
    let r = { x: 0, y: 0, w: W, h: H };
    for (const f of TRUE_FOLDS[fold].folds) {
      if (f === "v") {
        front.push(foldLine(r.x + r.w / 2, r.y, r.x + r.w / 2, r.y + r.h));
        r = { ...r, x: r.x + r.w / 2, w: r.w / 2 };
      } else {
        front.push(foldLine(r.x, r.y + r.h / 2, r.x + r.w, r.y + r.h / 2));
        r = { ...r, y: r.y + r.h / 2, h: r.h / 2 };
      }
    }
  } else if (marks?.folds && fold === "cut") {
    // Each column pair is one folio, folded at its spine.
    for (let j = 0; j < cols / 2; j++) {
      const x = origin.x + (2 * j + 1) * page.w;
      front.push(foldLine(x, origin.y, x, origin.y + rows * page.h));
    }
  }
  if (marks?.cuts && (fold === "cut" || fold === "leaves")) {
    // Ticks lie on each cut line where it meets the sheet edges; a line inside
    // the dead zone can't be marked at all.
    const ok = (v: number, edge: number) =>
      v >= DEAD_ZONE && v <= edge - DEAD_ZONE;
    const cut = (x1: number, y1: number, x2: number, y2: number) =>
      front.push({ kind: "cut", x1, y1, x2, y2 });
    for (let r = 0; r <= rows; r++) {
      const y = origin.y + r * page.h;
      if (!ok(y, H)) continue;
      cut(DEAD_ZONE, y, DEAD_ZONE + TICK, y);
      cut(W - DEAD_ZONE - TICK, y, W - DEAD_ZONE, y);
    }
    // cut: only between folios; leaves: between every column.
    for (let c = 0; c <= cols; c += fold === "cut" ? 2 : 1) {
      const x = origin.x + c * page.w;
      if (!ok(x, W)) continue;
      cut(x, DEAD_ZONE, x, DEAD_ZONE + TICK);
      cut(x, H - DEAD_ZONE - TICK, x, H - DEAD_ZONE);
    }
  }

  // Sewing stations go on each signature's centre recto (leaves have none), at
  // its spine edge; its own slot coordinates already carry any back mirroring.
  const sewing = (slots: Imposition["sheets"][number]["front"]): MarkDot[] => {
    const s = marks?.sewing;
    if (!s) return [];
    const dots: MarkDot[] = [];
    for (const slot of slots.filter((sl) => sl.centre)) {
      const x = slot.rotate === 0 ? slot.x : slot.x + page.w;
      const top = slot.y + s.kettle;
      const step = (page.h - 2 * s.kettle) / (s.stations + 1);
      for (let i = 0; i <= s.stations + 1; i++) {
        dots.push({ x, y: top + i * step });
      }
    }
    return dots;
  };

  return imp.sheets.map((sh) => ({
    front: { dots: sewing(sh.front), lines: [...front] },
    back: { dots: sewing(sh.back), lines: [] },
  }));
}
