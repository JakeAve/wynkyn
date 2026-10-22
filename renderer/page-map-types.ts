// renderer/page-map-types.ts — the page map's shapes shared by the export
// (server/) and the preview (web/); renderer/folios.js produces them.

/** Anchor id → the page number printed for it (TOC rows, `{ref}`). */
export type Seed = Record<string, string>;

/**
 * `page` is the 1-based physical page; null for a book-wide problem. A `warn`
 * problem is listed but never blocks an export.
 */
export interface PageProblem {
  page: number | null;
  message: string;
  warn?: true;
}

export function formatProblem(p: PageProblem): string {
  return p.page === null ? p.message : `page ${p.page}: ${p.message}`;
}
