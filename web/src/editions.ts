// web/src/editions.ts — pure helpers for the book/edition switcher (no DOM).
import type { EditionInfo } from "../../server/editions.ts";
import { DEFAULT_EDITION_TOKEN, type OnlySpan } from "../../parser/types.ts";

export type { EditionInfo };

// The server already resolves the name ("Standard" for an unnamed default).
export function editionLabel(info: EditionInfo): string {
  return info.name;
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
  const token = edition ?? DEFAULT_EDITION_TOKEN;
  return spans.find((s) => s.editions.includes(token))?.line ?? null;
}

// The editor line a switcher jump carries across the navigation: `#line=12`.
export function lineFromHash(hash: string): number | null {
  const m = hash.match(/^#line=(\d+)$/);
  return m ? Number(m[1]) : null;
}
