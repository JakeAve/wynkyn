// web/src/config-data.ts — pure form-model helpers for the configuration
// panel (spec §7.5). No DOM: everything here is unit-tested in Deno.
import type {
  CssProps,
  FolioPosition,
  Metadata,
  NumberingStyle,
  Running,
  RunningEntry,
} from "../../metadata/types.ts";
// Size parsing and derivation are shared with the print exporter so the panel
// and `bml export` can never disagree about the geometry (§4.3).
import { foldedSize } from "../../metadata/page-setup.ts";
export {
  DEFAULT_SIZE,
  describePageSetup,
  fmtLength,
  isValidSize,
  resolvePageSetup,
  tryParseDims,
} from "../../metadata/page-setup.ts";

export interface SizePreset {
  label: string;
  value: string;
}

// A folded sheet, named. The size is derived rather than written out, so these
// can never drift from the sheet they come off: halving folds once and splits
// the long side, quartering cuts across and folds, halving both sides.
function folded(name: string, sheet: string, rows: 1 | 2): SizePreset {
  const value = foldedSize(sheet, 2, rows);
  return { label: `${name} (${value.replace(" ", " × ")})`, value };
}

// The book page sizes offered in the panel: the named CSS sizes worth reaching
// for plus the common hand-binding formats. Any size in §4.3's value space can
// still be typed in as a custom one.
export const PAGE_SIZE_PRESETS: SizePreset[] = [
  { label: "A4 (210mm × 297mm)", value: "A4" },
  { label: "A5 (148mm × 210mm)", value: "A5" },
  folded("A5 folded", "A5", 1),
  { label: "US Letter (8.5in × 11in)", value: "letter" },
  folded("Half Letter", "letter", 1),
  folded("Quarter Letter", "letter", 2),
  { label: "US Legal (8.5in × 14in)", value: "legal" },
  folded("Half Legal", "legal", 1),
  folded("Quarter Legal", "legal", 2),
  { label: "US Trade (6in × 9in)", value: "6in 9in" },
];

// The paper a printer actually loads — sheets, not book pages.
export const SHEET_PRESETS: SizePreset[] = [
  { label: "US Letter (8.5in × 11in)", value: "letter" },
  { label: "US Legal (8.5in × 14in)", value: "legal" },
  { label: "US Tabloid (11in × 17in)", value: "tabloid" },
  { label: "A3 (297mm × 420mm)", value: "A3" },
  { label: "A4 (210mm × 297mm)", value: "A4" },
  { label: "A5 (148mm × 210mm)", value: "A5" },
];

// Which preset in `presets` a stored size corresponds to; "custom" when none
// matches (including undefined — nothing configured yet).
export function presetFor(
  size: string | undefined,
  presets: SizePreset[] = PAGE_SIZE_PRESETS,
): string {
  if (!size) return "custom";
  const norm = size.trim().toLowerCase();
  const hit = presets.find((p) => p.value.toLowerCase() === norm);
  return hit ? hit.value : "custom";
}

export function isValidFolios(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

export const NUMBERING_STYLES: NumberingStyle[] = [
  "arabic",
  "roman-upper",
  "roman-lower",
  "alpha-upper",
  "alpha-lower",
  "words",
  "none",
];
// Page counters are CSS counters; "words" has no CSS equivalent (§4.7).
export const PAGE_NUMBERING_STYLES: NumberingStyle[] = NUMBERING_STYLES.filter((
  s,
) => s !== "words");

export const RUNNING_CONTENT_CHOICES = [
  "book-title",
  "chapter-title",
  "part-title",
  "page-number",
  "none",
] as const;

// "font-size: 8pt\nfont-style: italic" ↔ { "font-size": "8pt", ... }.
// Splits each line on the FIRST colon (values may contain colons), tolerates
// blank lines and trailing semicolons, drops lines without a colon — the
// panel round-trips this as the user types, so it must never throw.
export function parseCssLines(text: string): CssProps {
  const props: CssProps = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const prop = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/;$/, "").trim();
    if (prop && value) props[prop] = value;
  }
  return props;
}

export function formatCssLines(props: CssProps): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export interface RunningEntryForm {
  content: string; // one of RUNNING_CONTENT_CHOICES, or a literal string
  area: string;
  extraCss: string; // css-lines text for every other property in the entry
}

export function splitRunningEntry(entry: RunningEntry): RunningEntryForm {
  const extras: CssProps = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k !== "content" && k !== "area") extras[k] = v;
  }
  return {
    content: entry.content,
    area: entry.area,
    extraCss: formatCssLines(extras),
  };
}

export function makeRunningEntry(form: RunningEntryForm): RunningEntry {
  const extras = parseCssLines(form.extraCss);
  delete extras["content"]; // the real keys always win over pasted css lines
  delete extras["area"];
  return { content: form.content, area: form.area, ...extras };
}

// The running heads' simple view (spec R5): what the first entry on each side
// shows, and the shared size / italic / font across every entry. A property
// the entries disagree on reads "mixed".
export function runningSummary(running: Running | undefined): {
  left: string;
  right: string;
  size: string | "mixed" | undefined;
  italic: boolean | "mixed";
  font: string | "mixed" | undefined;
} {
  const all = [...(running?.odd ?? []), ...(running?.even ?? [])];
  const agree = <T>(pick: (e: RunningEntry) => T): T | "mixed" | undefined =>
    new Set(all.map(pick)).size > 1 ? "mixed" : all[0] && pick(all[0]);
  return {
    left: running?.even?.[0]?.content ?? "none",
    right: running?.odd?.[0]?.content ?? "none",
    size: agree((e) => e["font-size"]),
    italic: agree((e) => e["font-style"] === "italic") ?? false,
    font: agree((e) => e["font-family"]),
  };
}

// The simple view's head positions, as [odd area, even area]: odd pages are
// recto, so outside is the right box on odd and the left on even.
export const HEAD_AREAS: Record<FolioPosition, [odd: string, even: string]> = {
  "top-outside": ["top-right", "top-left"],
  "top-center": ["top-center", "top-center"],
  "bottom-outside": ["bottom-right", "bottom-left"],
  "bottom-center": ["bottom-center", "bottom-center"],
};

// Where the first head on each side sits, as one mirrored position; undefined
// when there are no heads or they sit where no position puts them.
export function headPosition(
  running: Running | undefined,
): FolioPosition | undefined {
  const odd = running?.odd?.[0]?.area;
  const even = running?.even?.[0]?.area;
  if (!odd && !even) return undefined;
  return (Object.keys(HEAD_AREAS) as FolioPosition[]).find((p) =>
    (!odd || HEAD_AREAS[p][0] === odd) && (!even || HEAD_AREAS[p][1] === even)
  );
}

// Move the first head on each side to a position; further entries stay put.
export function setHeadPosition(running: Running, at: FolioPosition): void {
  const [odd, even] = HEAD_AREAS[at];
  if (running.odd?.[0]) running.odd[0].area = odd;
  if (running.even?.[0]) running.even[0].area = even;
}

// Write one shared property to every entry on both sides; undefined deletes.
export function setRunningShared(
  running: Running,
  prop: "font-size" | "font-style" | "font-family",
  value: string | undefined,
): void {
  for (const e of [...(running.odd ?? []), ...(running.even ?? [])]) {
    if (value === undefined) delete e[prop];
    else e[prop] = value;
  }
}

// Rename an object key preserving entry order (font-alias rename).
export function renameKey<T>(
  obj: Record<string, T>,
  from: string,
  to: string,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

// Renames a book color (§4.15) and every `color` / `*-color` value that names
// it, in elements, `is` styles, page numbers and running heads, so nothing
// left pointing at the old name falls back to black.
export function renameColor(meta: Metadata, from: string, to: string): void {
  meta.colors = renameKey(meta.colors ?? {}, from, to);
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (
        v === from && (k === "color" || k.endsWith("-color"))
      ) (o as Record<string, unknown>)[k] = to;
      else walk(v);
    }
  };
  walk([meta.elements, meta.is, meta.numbering, meta.running]);
}

// ---------- style panel (spec §7.4) ----------

// The properties a typesetter actually changes, in form order. Everything
// else on an element goes to the "more CSS" rows.
export const CURATED_PROPS = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-align",
  "letter-spacing",
  "text-transform",
  "margin-top",
  "margin-bottom",
] as const;

export function splitProps(
  props: Record<string, unknown>,
): { curated: CssProps; extra: CssProps } {
  const curated: CssProps = {};
  const extra: CssProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v !== "string") continue; // nested sub-element — not ours
    if ((CURATED_PROPS as readonly string[]).includes(k)) curated[k] = v;
    else extra[k] = v;
  }
  return { curated, extra };
}

// ---------- length steppers (style panel controls) ----------

// "9pt" -> { n: 9, unit: "pt" }; "1.5" -> unit ""; anything else -> null.
export function parseLength(v: string): { n: number; unit: string } | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(v.trim());
  return m ? { n: Number(m[1]), unit: m[2]! } : null;
}

// How far one arrow-key press moves a value in this unit.
export function stepFor(unit: string): number {
  return ({
    pt: 0.5,
    em: 0.05,
    mm: 1,
    in: 0.125,
    lh: 0.25,
    px: 1,
    "%": 1,
  } as Record<
    string,
    number
  >)[unit] ?? 1;
}

// Bump a CSS length one step, keeping its unit. An empty or invalid `v`
// bumps `fallback` instead (the inherited value the field is showing).
export function bumpLength(v: string, dir: 1 | -1, fallback: string): string {
  const p = parseLength(v) ?? parseLength(fallback) ?? { n: 0, unit: "" };
  const n = Math.round((p.n + dir * stepFor(p.unit)) * 1000) / 1000;
  return `${n}${p.unit}`;
}

// Units the stepper offers. Absolute ones convert exactly; em, lh and % depend
// on the font or box, so switching to or from them keeps the number.
export const LENGTH_UNITS = ["pt", "mm", "in", "px", "em", "lh", "%"];
const PT: Record<string, number> = { pt: 1, mm: 72 / 25.4, in: 72, px: 0.75 };

export function convertLength(v: string, to: string): string {
  const p = parseLength(v);
  if (!p) return v;
  const a = PT[p.unit], b = PT[to];
  const n = a && b ? Math.round((p.n * a / b) * 100) / 100 : p.n;
  return `${n}${to}`;
}
