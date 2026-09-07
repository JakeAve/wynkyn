// server/editions.ts — where an edition's metadata lives on disk, and what the
// app shows for it. An edition is purely styling: one complete metadata file.
// `metadata.json` is the unnamed edition (edition === null); named editions
// are `editions/<slug>.json`. The manuscript and images are shared.
import type { Metadata } from "../metadata/types.ts";

// One path segment: no separators, no dot-dot, no leading dot.
export function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

export function metadataPath(
  booksRoot: string,
  book: string,
  edition: string | null = null,
): string {
  return edition === null
    ? `${booksRoot}/${book}/metadata.json`
    : `${booksRoot}/${book}/editions/${edition}.json`;
}

// Who a changed file affects: every client on the book, or one edition's clients.
export type Change =
  | { kind: "shared" }
  | { kind: "edition"; edition: string | null };

export function classifyChange(rest: string[]): Change | null {
  const [first, second] = rest;
  if (first === "manuscript.md" || first === "images") {
    return { kind: "shared" };
  }
  if (first === "metadata.json") return { kind: "edition", edition: null };
  if (first === "editions" && rest.length === 2 && second?.endsWith(".json")) {
    return { kind: "edition", edition: second.slice(0, -".json".length) };
  }
  return null;
}

// The one line the edition picker shows per row.
export function summaryOf(meta: Metadata): string {
  const body = (meta.elements?.body ?? {}) as Record<string, unknown>;
  const family = body["font-family"];
  const font = typeof family === "string"
    ? meta.fonts?.[family] ?? family
    : undefined;
  const size = body["font-size"];
  return [meta.page?.size, font, typeof size === "string" ? size : undefined]
    .filter(Boolean).join(" · ");
}

export interface EditionInfo {
  slug: string | null; // null = the unnamed edition
  summary: string;
}

export async function listEditions(
  booksRoot: string,
  book: string,
): Promise<EditionInfo[]> {
  const summary = async (edition: string | null): Promise<string> => {
    try {
      const text = await Deno.readTextFile(
        metadataPath(booksRoot, book, edition),
      );
      return summaryOf(JSON.parse(text) as Metadata);
    } catch {
      return ""; // missing or corrupt — the row still lists, just without a summary
    }
  };
  const out: EditionInfo[] = [{ slug: null, summary: await summary(null) }];
  const slugs: string[] = [];
  try {
    for await (const e of Deno.readDir(`${booksRoot}/${book}/editions`)) {
      if (e.isFile && e.name.endsWith(".json")) {
        slugs.push(e.name.slice(0, -".json".length));
      }
    }
  } catch {
    // no editions/ directory — a single-edition book
  }
  for (const slug of slugs.sort()) {
    out.push({ slug, summary: await summary(slug) });
  }
  return out;
}

// Writes a new named edition. Throws Deno.errors.AlreadyExists on a duplicate.
export async function createEdition(
  booksRoot: string,
  book: string,
  slug: string,
  metadata: unknown,
): Promise<void> {
  await Deno.mkdir(`${booksRoot}/${book}/editions`, { recursive: true });
  await Deno.writeTextFile(
    metadataPath(booksRoot, book, slug),
    JSON.stringify(metadata, null, 2) + "\n",
    { createNew: true },
  );
}
