// web/src/preview-cache.ts — pure keys + an IndexedDB store of laid-out
// segments: one manifest per book+edition (`books`) naming one row per
// segment (`segments`), so an edit re-lays only the segments it touched.
import type {
  PageEntry,
  PageFacts,
  PageProblem,
  Seed,
  Segment,
} from "../../renderer/page-map-types.ts";
import type { PageNumberingConfig } from "../../metadata/css-generator.ts";
import { BUILD_ID } from "../../renderer/build-id.ts";
import { escapeHtml } from "../../renderer/render.ts";

/** One segment laid out alone. `pages` is stored with `data-line`s relative
 * to the segment's `line` and image URLs as `wynkyn-image:<name>`; the caller
 * rewrites both (`shiftLines`, `tokenImages`/`untokenImages`) on save and load. */
export interface CachedSegment {
  pages: string;
  facts: PageFacts[];
  problems: PageProblem[];
}

/** A book's manifest: what assembly needs besides the segment rows. */
export interface CachedRender {
  styleHash: string;
  scope: string;
  styles: string[];
  pageTemplate: string;
  fontLinks: string;
  pageNumbering: PageNumberingConfig;
  seed: Seed;
  segments: Array<
    { key: string; line: number; opens: Segment["opens"]; ids: string[] }
  >;
}

const DB_NAME = "preview-cache";
const SEGMENTS = "segments";
const BOOKS = "books";
const SEP = "\x1f"; // ASCII unit separator; cannot appear in HTML/CSS.
const TOKEN = "wynkyn-image:";

// cyrb53: a fast non-cryptographic 53-bit string hash. Sync and available on
// plain http over a LAN IP, where crypto.subtle is undefined.
function hash(parts: string[]): string {
  const text = parts.join(SEP);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function styleHash(
  u: { baseCss: string; domCss: string; pagedCss: string; fontLinks: string },
): string {
  return hash([u.baseCss, u.domCss, u.pagedCss, u.fontLinks]);
}

/** Names a segment's layout: its own text (wherever it sits in the
 * manuscript, whatever URL its images have this session), the book's styles,
 * the page numbers it prints and the layout code. `pageNumbering` is left
 * out: assembly applies it, so a numbering change lays out nothing. */
export function segmentKey(
  s: Segment,
  styleHash: string,
  seed: Seed,
  imageUrls: Record<string, string>,
): string {
  return hash([
    tokenImages(shiftLines(s.html, -s.line), imageUrls),
    styleHash,
    ...s.reads.map((a) => seed[a] ?? "000"),
    BUILD_ID,
  ]);
}

/** Adds `delta` to every `data-line`. */
export function shiftLines(html: string, delta: number): string {
  return html.replace(
    /data-line="(-?\d+)"/g,
    (_, n: string) => `data-line="${Number(n) + delta}"`,
  );
}

/** Image URLs (file name → URL, `BuildResult.imageUrls`) → `wynkyn-image:<name>`. */
export function tokenImages(
  html: string,
  imageUrls: Record<string, string>,
): string {
  for (const [name, url] of Object.entries(imageUrls)) {
    const token = `"${TOKEN}${encodeURIComponent(name)}"`;
    html = html.replaceAll(`"${escapeHtml(url)}"`, () => token);
  }
  return html;
}

/** `wynkyn-image:<name>` → this session's URL for the file. */
export function untokenImages(
  html: string,
  url: (name: string) => string,
): string {
  return html.replace(
    new RegExp(`"${TOKEN}([^"]*)"`, "g"),
    (_, n: string) => `"${escapeHtml(url(decodeURIComponent(n)))}"`,
  );
}

export function cacheId(book: string, edition: string | null): string {
  return `${book}|${edition ?? ""}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 2);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 1 kept one whole render per book.
      if (db.objectStoreNames.contains("renders")) {
        db.deleteObjectStore("renders");
      }
      for (const name of [SEGMENTS, BOOKS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      // Let a tab with a newer version upgrade instead of blocking on us.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

type Stores = { segments: IDBObjectStore; books: IDBObjectStore };

// Runs `fn` in one transaction over both stores; resolves with what its
// returned getter reads once the transaction commits, or null on any failure.
async function transact<T>(
  mode: IDBTransactionMode,
  fn: (s: Stores) => () => T,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([SEGMENTS, BOOKS], mode);
      const result = fn({
        segments: tx.objectStore(SEGMENTS),
        books: tx.objectStore(BOOKS),
      });
      tx.oncomplete = () => resolve(result());
      tx.onerror = tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Deletes the segment rows no manifest names.
function sweep(s: Stores): void {
  const books = s.books.getAll();
  books.onsuccess = () => {
    const named = new Set(
      (books.result as CachedRender[]).flatMap((b) =>
        b.segments.map((x) => x.key)
      ),
    );
    const keys = s.segments.getAllKeys();
    keys.onsuccess = () => {
      for (const k of keys.result) {
        if (!named.has(k as string)) s.segments.delete(k);
      }
    };
  };
}

export async function loadCachedSegment(
  key: string,
): Promise<CachedSegment | null> {
  return await transact("readonly", (s) => {
    const req = s.segments.get(key);
    return () => (req.result as CachedSegment | undefined) ?? null;
  });
}

/** The book's manifest and every row it names, in its order; null when any
 * row is missing (a restore is all or nothing). */
export async function loadCachedRender(
  id: string,
): Promise<{ render: CachedRender; segments: CachedSegment[] } | null> {
  return await transact("readonly", (s) => {
    const book = s.books.get(id);
    const rows: IDBRequest<CachedSegment | undefined>[] = [];
    book.onsuccess = () => {
      for (
        const seg of (book.result as CachedRender | undefined)?.segments ?? []
      ) {
        rows.push(s.segments.get(seg.key));
      }
    };
    return () => {
      const render = book.result as CachedRender | undefined;
      const segments: CachedSegment[] = [];
      for (const r of rows) {
        if (!r.result) return null;
        segments.push(r.result);
      }
      return render ? { render, segments } : null;
    };
  });
}

/** Saves the manifest and `rows` (segment key → row), then sweeps rows no
 * manifest names. */
export async function saveCachedRender(
  id: string,
  render: CachedRender,
  rows: Map<string, CachedSegment>,
): Promise<void> {
  await transact("readwrite", (s) => {
    s.books.put(render, id);
    for (const [key, row] of rows) s.segments.put(row, key);
    sweep(s);
    return () => {};
  });
}

// Courtesy cleanup when an edition is renamed or deleted; an orphan row is
// never read, it just takes up space until the browser evicts it.
export async function deleteCachedRender(id: string): Promise<void> {
  await transact("readwrite", (s) => {
    s.books.delete(id);
    sweep(s);
    return () => {};
  });
}

// --- Legacy whole-render API, kept only so preview.ts, app.ts and
// theme-preview.ts compile until they move to segments. The store it used is
// gone, so it never restores and never saves. Delete with those callers.

export interface LegacyRender {
  hash: string;
  pages: string;
  styles: string[];
  fontLinks: string;
  seed: Seed;
  problems: PageProblem[];
  map?: PageEntry[];
}

export function restoredPageMap(
  c: LegacyRender,
): { seed: Seed; problems: PageProblem[]; map: PageEntry[] } {
  return { seed: c.seed ?? {}, problems: c.problems ?? [], map: c.map ?? [] };
}

export function restoredHash(c: LegacyRender): string | null {
  return c.map ? c.hash : null;
}

export function renderHash(
  u: {
    html: string;
    baseCss: string;
    domCss: string;
    pagedCss: string;
    fontLinks: string;
    pageNumbering?: unknown;
  },
): string {
  return hash([
    u.html,
    u.baseCss,
    u.domCss,
    u.pagedCss,
    u.fontLinks,
    JSON.stringify(u.pageNumbering ?? null),
  ]);
}

export function loadLegacyRender(_id: string): Promise<LegacyRender | null> {
  return Promise.resolve(null);
}

export function saveLegacyRender(_id: string, _r: LegacyRender): Promise<void> {
  return Promise.resolve();
}
