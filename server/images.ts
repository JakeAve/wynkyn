// server/images.ts — what a book's images/ folder accepts and how an added
// file is named. Pure: the pipeline, the book service and the browser share it.

/** Accepted extensions, in the order the resolver tries them for a slug
 * (spec §4.11 item 8). */
export const IMAGE_EXTS: readonly string[] = [
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
];

/** A file in images/: its slug (what `{illustration:}` names) and file name. */
export interface ImageFile {
  slug: string;
  name: string;
}

/** `Marley's Ghost.JPG` → `{ slug: "marleys-ghost", ext: "jpg" }`; null when
 * the extension isn't accepted. */
export function imageSlug(
  filename: string,
): { slug: string; ext: string } | null {
  const dot = filename.lastIndexOf(".");
  const ext = dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) return null;
  const slug = filename.slice(0, dot).normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { slug: slug || "image", ext };
}

/** `slug` when free, else the first free `slug-2`, `slug-3`, … */
export function freeSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}
