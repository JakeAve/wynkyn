// web/src/editions.ts — pure helpers for the book/edition switcher (no DOM).
import { type EditionInfo, editionToken } from "../../server/editions.ts";
import type { OnlySpan } from "../../parser/types.ts";

export type { EditionInfo };

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// A slug for a new edition that no existing one has: `caslon`, then
// `caslon-2`, `caslon-3`… "default" names the unnamed edition, so never it.
export function freeSlug(base: string, taken: string[]): string {
  const root = slugify(base) || "edition";
  const used = new Set([...taken, "default"]);
  let slug = root;
  for (let n = 2; used.has(slug); n++) slug = `${root}-${n}`;
  return slug;
}

export function editionHref(book: string, edition: string | null): string {
  let href = `?book=${encodeURIComponent(book)}`;
  if (edition !== null) href += `&edition=${encodeURIComponent(edition)}`;
  return href;
}

// "5.25in 8in" → "5.25 × 8 in"; mixed units keep theirs; "A5" stays "A5".
export function prettySize(size: string): string {
  const m = size.trim().match(/^([\d.]+)([a-z]+)\s+([\d.]+)([a-z]+)$/);
  if (!m) return size.trim();
  const [, w, wu, h, hu] = m;
  return wu === hu ? `${w} × ${h} ${wu}` : `${w}${wu} × ${h}${hu}`;
}

export function passagesLabel(n: number): string {
  return `${n} passage${n === 1 ? "" : "s"} of its own`;
}

// The first `{only}` span that lists this edition, as a source line.
export function firstSpanLine(
  spans: OnlySpan[],
  edition: string | null,
): number | null {
  const token = editionToken(edition);
  return spans.find((s) => s.editions.includes(token))?.line ?? null;
}

// The app's whole place in one URL, so a reload lands where the author was
// and a pasted link opens there for someone else. Every part heals on load:
// an unknown book, edition, mode, view or line falls back to a default.
export function appHref(s: {
  book: string;
  edition: string | null;
  mode: string;
  view: string | null; // the Style/Publish nav row (config-panel.ts navId)
  line: number; // the editor's cursor line, 1-based
  lib?: string | null; // the library's id; a link from another is sent home
}): string {
  let href = editionHref(s.book, s.edition);
  if (s.lib) href += `&lib=${encodeURIComponent(s.lib)}`;
  if (s.mode !== "write") href += `&mode=${s.mode}`;
  if (s.view) href += `&view=${encodeURIComponent(s.view)}`;
  return s.line > 1 ? `${href}#line=${s.line}` : href;
}

// The editor line a switcher jump carries across the navigation: `#line=12`.
export function lineFromHash(hash: string): number | null {
  const m = hash.match(/^#line=(\d+)$/);
  return m ? Number(m[1]) : null;
}
