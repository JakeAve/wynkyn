// web/src/config-data.ts — pure form-model helpers for the configuration
// panel (spec §7.5). No DOM: everything here is unit-tested in Deno.
import type {
  CssProps,
  NumberingStyle,
  RunningEntry,
} from "../../metadata/types.ts";
// Size parsing and derivation are shared with the print exporter so the panel
// and `bml export` can never disagree about the geometry (§4.3).
import { foldedSize } from "../../metadata/page-setup.ts";
export {
  describePageSetup,
  fmtLength,
  isValidSize,
  resolvePageSetup,
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

// The 16 CSS Paged Media margin boxes, in §4.8's order.
export const MARGIN_AREAS = [
  "top-left-corner",
  "top-left",
  "top-center",
  "top-right",
  "top-right-corner",
  "right-top",
  "right-middle",
  "right-bottom",
  "bottom-right-corner",
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "bottom-left-corner",
  "left-bottom",
  "left-middle",
  "left-top",
] as const;

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
