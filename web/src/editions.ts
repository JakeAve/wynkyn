// web/src/editions.ts — pure helpers for the edition switcher (no DOM).

// "large-print" → "Large Print"; null is the book's unnamed edition.
export function editionLabel(slug: string | null): string {
  if (slug === null) return "Unnamed edition";
  return slug.split("-").map((w) => w ? w[0]!.toUpperCase() + w.slice(1) : w)
    .join(" ");
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function editionHref(book: string, edition: string | null): string {
  let href = `?book=${encodeURIComponent(book)}`;
  if (edition !== null) href += `&edition=${encodeURIComponent(edition)}`;
  return href;
}
