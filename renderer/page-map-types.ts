// renderer/page-map-types.ts — the page map's shapes shared by the export
// (server/) and the preview (web/); renderer/folios.js produces them.

/** One physical page of a settled render; see the PageEntry JSDoc in folios.js. */
export interface PageEntry {
  index: number;
  zone: "front" | "body" | "back";
  display: boolean;
  blank: boolean;
  empty: boolean;
  opener: boolean;
  head: boolean;
  folio: number;
  folioText: string;
  refText: string;
  chapterTitle: string;
  partTitle: string;
  anchors: string[];
}

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

/** The render settled with page-map problems and `force` was not set. */
export class PaginationError extends Error {
  constructor(readonly problems: PageProblem[]) {
    super(
      `pagination problems (--force to export anyway):\n${
        problems.map((p) => `  ${formatProblem(p)}`).join("\n")
      }`,
    );
  }
}
