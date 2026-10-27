// web/src/inspect-facts.ts — the Inspect drawer's "Why it's here" from plain
// measured facts, and line grouping for the pinned block. Pure: no DOM.
import type { PageEntry } from "../../renderer/page-map-types.ts";

export type Pinned =
  | "block"
  | "span"
  | "line"
  | "space"
  | "furniture"
  | "ghost";

export interface InspectFacts {
  kind: Pinned;
  /** The element's name, from style-catalog.ts. */
  label: string;
  page: PageEntry | null;
  firstOnPage: boolean;
  /** Computed `break-before`. */
  breakBefore: string;
  /** This fragment continues a block from the previous page. */
  splitFrom: boolean;
  /** refText of the page the block continues onto, else null. */
  continuesOn: string | null;
  textAlignLast: string;
  hyphens: string;
  line: { n: number; of: number; hyphenated: boolean } | null;
  ref: { id: string; refText: string } | null;
  furniture: "head" | "folio" | null;
  /** For kind "space": the title of the chapter or part opening the next page. */
  nextOpens: string | null;
}

export interface Reason {
  text: string;
  source: string;
}

// Every string the drawer shows, in one place so the wording can be tuned.
const SAY = {
  newPage: "Starts a new page",
  rightPage: "Starts on a right-hand page",
  leftPage: "Starts on a left-hand page",
  breakSource: (v: string) => `Book default · break-before: ${v}`,
  openerHidden: (what: string) => `Not printed: this page opens a ${what}`,
  displayHidden: "Not printed: display page",
  blankHidden: "Not printed: blank page",
  headsBodyOnly: "Not printed: running heads are on body pages only",
  folioDropped: "Page number dropped on chapter openings",
  folioOff: "Not printed: page numbers are off here",
  splitFrom: "Continues from the previous page",
  continuesOn: (n: string) => `Continues on page ${n}`,
  stretched: "Last line stretched: the paragraph goes on overleaf",
  alignLastSource: "Book default · text-align-last",
  lineOf: (n: number, of: number) => `Line ${n} of ${of}`,
  hyphen: "Breaks the word with a hyphen",
  hyphensSource: (v: string) => `Book default · hyphens: ${v}`,
  ref: (n: string) =>
    `Filled in from the page map: page ${n}, checked after every layout`,
  chapterEnds: (t: string) => `Chapter ends here; “${t}” starts a new page`,
  keptWhole: "Nothing more fits: the next block is kept whole",
  head: "Running head: the chapter title, on body pages",
  folio: "Page number",
  frontNumbering: "Front pages use their own numbering",
  firstOnPage: "First on the page: the previous page was full",
  pageMap: "Page map",
  layout: "Layout",
  bookDefault: "Book default",
  headsStyle: "Style › Running heads",
  foliosStyle: "Style › Page numbers",
} as const;

export function reasonsFor(f: InspectFacts): Reason[] {
  const p = f.page;
  if (f.kind === "ghost") return ghostReasons(f);
  if (f.kind === "space") {
    return [
      f.nextOpens === null
        ? { text: SAY.keptWhole, source: SAY.bookDefault }
        : {
          text: SAY.chapterEnds(f.nextOpens),
          source: SAY.breakSource("page"),
        },
    ];
  }
  if (f.kind === "furniture") {
    const out: Reason[] = f.furniture === "head"
      ? [{ text: SAY.head, source: SAY.headsStyle }]
      : [{ text: SAY.folio, source: SAY.foliosStyle }];
    if (f.furniture === "folio" && p?.zone === "front") {
      out.push({ text: SAY.frontNumbering, source: SAY.foliosStyle });
    }
    return out;
  }

  const out: Reason[] = [];
  if (f.firstOnPage && !f.splitFrom) {
    const text = f.breakBefore === "page"
      ? SAY.newPage
      : f.breakBefore === "right" || f.breakBefore === "recto"
      ? SAY.rightPage
      : f.breakBefore === "left" || f.breakBefore === "verso"
      ? SAY.leftPage
      : null;
    if (text) out.push({ text, source: SAY.breakSource(f.breakBefore) });
  }
  if (f.splitFrom) out.push({ text: SAY.splitFrom, source: SAY.layout });
  if (f.continuesOn !== null) {
    out.push({ text: SAY.continuesOn(f.continuesOn), source: SAY.layout });
    if (f.textAlignLast === "justify") {
      out.push({ text: SAY.stretched, source: SAY.alignLastSource });
    }
  }
  if (f.line) {
    out.push({ text: SAY.lineOf(f.line.n, f.line.of), source: SAY.layout });
    if (f.line.hyphenated) {
      out.push({ text: SAY.hyphen, source: SAY.hyphensSource(f.hyphens) });
    }
  }
  if (f.ref) out.push({ text: SAY.ref(f.ref.refText), source: SAY.pageMap });
  if (
    !out.length && f.kind === "block" && f.firstOnPage && p && p.index > 0
  ) {
    out.push({ text: SAY.firstOnPage, source: SAY.layout });
  }
  return out;
}

// Furniture the page map dropped, shown while Inspect is on.
function ghostReasons(f: InspectFacts): Reason[] {
  const p = f.page;
  if (!p) return [];
  if (p.blank) return [{ text: SAY.blankHidden, source: SAY.pageMap }];
  if (p.display) return [{ text: SAY.displayHidden, source: SAY.pageMap }];
  if (f.furniture === "folio") {
    return [
      p.opener
        ? { text: SAY.folioDropped, source: SAY.foliosStyle }
        : { text: SAY.folioOff, source: SAY.foliosStyle },
    ];
  }
  if (p.opener) {
    const what = !p.chapterTitle && p.partTitle ? "part" : "chapter";
    return [{ text: SAY.openerHidden(what), source: SAY.pageMap }];
  }
  if (p.zone !== "body") {
    return [{ text: SAY.headsBodyOnly, source: SAY.headsStyle }];
  }
  return [];
}

type Box = { top: number; bottom: number; left: number; right: number };

/** Merges rects whose vertical centres overlap into line boxes, top down. */
export function groupLines(rects: Box[]): Box[] {
  const lines: Box[] = [];
  for (const r of [...rects].sort((a, b) => a.top - b.top)) {
    const last = lines.at(-1);
    const mid = (r.top + r.bottom) / 2;
    if (
      last &&
      ((mid >= last.top && mid <= last.bottom) ||
        ((last.top + last.bottom) / 2 >= r.top &&
          (last.top + last.bottom) / 2 <= r.bottom))
    ) {
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

/**
 * The browser broke a word across these lines (an auto hyphen): a letter
 * (or a soft hyphen after one) ends the line and a letter starts the next,
 * with no whitespace between them.
 */
export function endsMidWord(lineText: string, nextLineText: string): boolean {
  return /\p{L}­?$/u.test(lineText) && /^\p{L}/u.test(nextLineText);
}

/**
 * An unzoomed CSS length in the book's unit (mm when its page size is
 * metric, else inches), one decimal: 96 px to the inch.
 */
export function bookLength(px: number, unit: "in" | "mm"): string {
  const inches = px / 96;
  return String(+(unit === "mm" ? inches * 25.4 : inches).toFixed(1));
}

/** px → pt, one decimal. */
export function points(px: number): string {
  return String(+(px * 0.75).toFixed(1));
}

/** The face a computed font-family list asks for first, unquoted. */
export function faceOf(family: string): string {
  return (family.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

/** A measured distance: along `axis`, from → to, drawn across at `at`. */
export interface Gap {
  axis: "x" | "y";
  from: number;
  to: number;
  at: number;
}

/**
 * What ⌥ draws between the pinned box `a` and the hovered `b`, per axis: the
 * gap between them when they don't overlap, the inset at both ends when one
 * holds the other, nothing when they partly overlap. Under half a px is none.
 */
export function gaps(a: Box, b: Box): Gap[] {
  const out: Gap[] = [];
  for (const axis of ["y", "x"] as const) {
    const [lo, hi, olo, ohi] = axis === "y"
      ? ["top", "bottom", "left", "right"] as const
      : ["left", "right", "top", "bottom"] as const;
    const s = Math.max(a[olo], b[olo]);
    const e = Math.min(a[ohi], b[ohi]);
    const at = s <= e ? (s + e) / 2 : (b[olo] + b[ohi]) / 2;
    const push = (from: number, to: number) => {
      if (to - from > 0.5) out.push({ axis, from, to, at });
    };
    if (b[lo] >= a[hi]) push(a[hi], b[lo]);
    else if (a[lo] >= b[hi]) push(b[hi], a[lo]);
    else if (
      (a[lo] <= b[lo] && b[hi] <= a[hi]) || (b[lo] <= a[lo] && a[hi] <= b[hi])
    ) {
      push(Math.min(a[lo], b[lo]), Math.max(a[lo], b[lo]));
      push(Math.min(a[hi], b[hi]), Math.max(a[hi], b[hi]));
    }
  }
  return out;
}
