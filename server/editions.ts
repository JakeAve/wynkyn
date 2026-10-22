// server/editions.ts — where an edition's metadata lives on disk, and what the
// app shows for it. An edition is purely styling: one complete metadata file.
// `metadata.json` is the unnamed edition (edition === null); named editions
// are `editions/<slug>.json`. The manuscript and images are shared.
import type { Metadata } from "../metadata/types.ts";
import { describePageSetup, resolvePageSetup } from "../metadata/page-setup.ts";
import { upgradePageSetup } from "../metadata/upgrade.ts";
import { parse } from "../parser/parser.ts";
import { DEFAULT_EDITION_TOKEN } from "../parser/types.ts";
import { parseSentinelLine } from "../parser/sentinel.ts";
import { asStore, type BookStore } from "./store.ts";

// One path segment: no separators, no dot-dot, no leading dot.
export function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

/** The edition's metadata file, relative to the library root (a store path). */
export function metadataKey(
  book: string,
  edition: string | null = null,
): string {
  return edition === null
    ? `${book}/metadata.json`
    : `${book}/editions/${edition}.json`;
}

export function metadataPath(
  booksRoot: string,
  book: string,
  edition: string | null = null,
): string {
  return `${booksRoot}/${metadataKey(book, edition)}`;
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

// The one line the edition picker shows per row. Page setup leads: the physical
// format is what makes one edition different from another (§4.3).
export function summaryOf(meta: Metadata): string {
  const body = (meta.elements?.body ?? {}) as Record<string, unknown>;
  const family = body["font-family"];
  const font = typeof family === "string"
    ? meta.fonts?.[family] ?? family
    : undefined;
  const size = body["font-size"];
  // Only describe the imposition once a sheet is actually configured — the
  // resolver's default sheet is right for export, but a picker row must not
  // claim a setup the file never chose.
  const page = upgradePageSetup(meta).page;
  const setup = page?.sheet
    ? describePageSetup(resolvePageSetup(page))
    : page?.size;
  return [setup, font, typeof size === "string" ? size : undefined]
    .filter(Boolean).join(" · ");
}

// EXPERIMENTAL: the name an edition answers to in `{only}` (spec §3.2.9).
export function editionToken(slug: string | null): string {
  return slug ?? DEFAULT_EDITION_TOKEN;
}

// Every token a book's {only} spans may name: the default edition's, then its
// named editions' slugs.
export function editionTokens(slugs: string[]): string[] {
  return [null, ...slugs].map(editionToken);
}

// "a-christmas-carol" → "A Christmas Carol": a named edition's picker name,
// and the editor's book names.
export function titleCase(slug: string): string {
  return slug.split("-").map((w) => w ? w[0]!.toUpperCase() + w.slice(1) : w)
    .join(" ");
}

export interface EditionInfo {
  slug: string | null; // null = the unnamed edition
  name: string;
  summary: string;
  passages: number; // EXPERIMENTAL: {only} spans that list this edition
}

// Named edition slugs, sorted; [] for a single-edition book.
export async function editionSlugs(
  root: string | BookStore,
  book: string,
): Promise<string[]> {
  // No editions/ directory — a single-edition book — lists as [].
  const names = await asStore(root).listDir(`${book}/editions`);
  return names.filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length)).sort();
}

export async function listEditions(
  root: string | BookStore,
  book: string,
): Promise<EditionInfo[]> {
  const store = asStore(root);
  const source = await store.readText(`${book}/manuscript.md`);
  const spans = source === null ? [] : parse(source).onlySpans; // no manuscript — no passages
  const info = async (slug: string | null): Promise<EditionInfo> => {
    let meta: Metadata | null = null;
    try {
      meta = JSON.parse(
        (await store.readText(metadataKey(book, slug))) ?? "",
      ) as Metadata;
    } catch {
      // missing or corrupt — the row still lists, just without a summary
    }
    const token = editionToken(slug);
    return {
      slug,
      name: slug === null
        ? (typeof meta?.name === "string" && meta.name) || "Standard"
        : titleCase(slug),
      summary: meta ? summaryOf(meta) : "",
      passages: spans.filter((s) => s.editions.includes(token)).length,
    };
  };
  const out = [await info(null)];
  for (const slug of await editionSlugs(store, book)) {
    out.push(await info(slug));
  }
  return out;
}

// EXPERIMENTAL: renames one edition token in every {only} opening line's
// edition list; everything else is left byte for byte.
export function renameOnlyToken(
  source: string,
  from: string,
  to: string,
): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(
    `(^\\s*\\{only\\s*:\\s*|\\|\\s*)${esc}(?=\\s*[|}])`,
    "g",
  );
  return source.split("\n").map((line) => {
    const tag = parseSentinelLine(line);
    if (tag?.name !== "only" || tag.closing) return line;
    return line.replace(token, `$1${to}`);
  }).join("\n");
}

// Writes a new named edition; false (nothing written) on a duplicate.
// The default edition's display `name` is not copied: it names that edition only.
export function createEdition(
  root: string | BookStore,
  book: string,
  slug: string,
  metadata: unknown,
): Promise<boolean> {
  let copy = metadata;
  if (copy !== null && typeof copy === "object" && !Array.isArray(copy)) {
    const { name: _name, ...rest } = copy as Record<string, unknown>;
    copy = rest;
  }
  return asStore(root).create(
    metadataKey(book, slug),
    JSON.stringify(copy, null, 2) + "\n",
  );
}
