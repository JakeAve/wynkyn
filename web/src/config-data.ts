// web/src/config-data.ts — pure form-model helpers for the configuration
// panel (spec §7.5). No DOM: everything here is unit-tested in Deno.
import type { CssProps, NumberingStyle, RunningEntry } from "../../metadata/types.ts";

export interface SizePreset {
  label: string;
  value: string;
}

// Named CSS @page sizes plus common hand-binding trim sizes (§4.3's value space).
export const PAGE_SIZE_PRESETS: SizePreset[] = [
  { label: "A4 (210mm × 297mm)", value: "A4" },
  { label: "A5 (148mm × 210mm)", value: "A5" },
  { label: "US Letter (8.5in × 11in)", value: "letter" },
  { label: "US Legal (8.5in × 14in)", value: "legal" },
  { label: "Half Letter (5.5in × 8.5in)", value: "5.5in 8.5in" },
  { label: "Quarter Legal (3.5in × 8.5in)", value: "3.5in 8.5in" },
  { label: "US Trade (6in × 9in)", value: "6in 9in" },
];

// Which preset a stored size corresponds to; "custom" when none matches
// (including undefined — no size configured yet).
export function presetFor(size: string | undefined): string {
  if (!size) return "custom";
  const norm = size.trim().toLowerCase();
  const hit = PAGE_SIZE_PRESETS.find((p) => p.value.toLowerCase() === norm);
  return hit ? hit.value : "custom";
}

const LENGTH = /^\d+(\.\d+)?(in|mm|cm|pt|pc|px)$/;
const NAMED_SIZES = new Set([
  "a3", "a4", "a5", "b4", "b5", "jis-b4", "jis-b5", "letter", "legal", "ledger",
]);

// A size is a CSS named page size or "<length> <length>" (§4.3).
export function isValidSize(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1) return NAMED_SIZES.has(parts[0]!.toLowerCase());
  if (parts.length === 2) return parts.every((p) => LENGTH.test(p));
  return false;
}

export function isValidFolios(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

export const NUMBERING_STYLES: NumberingStyle[] = [
  "arabic", "roman-upper", "roman-lower", "alpha-upper", "alpha-lower", "none",
];

// The 16 CSS Paged Media margin boxes, in §4.8's order.
export const MARGIN_AREAS = [
  "top-left-corner", "top-left", "top-center", "top-right", "top-right-corner",
  "right-top", "right-middle", "right-bottom",
  "bottom-right-corner", "bottom-right", "bottom-center", "bottom-left",
  "bottom-left-corner",
  "left-bottom", "left-middle", "left-top",
] as const;

export const RUNNING_CONTENT_CHOICES = [
  "book-title", "chapter-title", "part-title", "page-number", "none",
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
  return { content: entry.content, area: entry.area, extraCss: formatCssLines(extras) };
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
