// web/src/preview-cache.ts — pure keys + an IndexedDB store of laid-out
// segments: one manifest per book+edition (`books`) naming one row per
// segment (`segments`), so an edit re-lays only the segments it touched.
import type {
  PageFacts,
  PageProblem,
  Seed,
  Segment,
} from "../../renderer/page-map-types.ts";
import type {
  DomRule,
  PageNumberingConfig,
} from "../../metadata/css-generator.ts";
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
  bookTitle?: string;
  pageNumbering: PageNumberingConfig;
  seed: Seed;
  // The book's problems as laid out: a restore assembles before its images
  // load, so it can't judge them itself.
  problems: PageProblem[];
  segments: Array<
    { key: string; line: number; opens: Segment["opens"]; ids: string[] }
  >;
  // Keys the book named before, newest first: the sweep spares their rows so
  // undoing an edit finds its pages. saveCachedRender keeps it.
  kept?: string[];
}

const DB_NAME = "preview-cache";
const SEGMENTS = "segments";
const BOOKS = "books";
const SEP = "\x1f"; // ASCII unit separator; cannot appear in HTML/CSS.
const TOKEN = "wynkyn-image:";
// Rows a book no longer names that are kept for undo, per book.
const KEEP = 300;

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

// A compound selector read here: an optional tag, then classes.
const COMPOUND = /^([a-z][a-z0-9-]*)?((?:\.[A-Za-z0-9_-]+)*)$/;

/** Whether a selector can match anything in `html`: some alternative whose
 * every tag and class appears there. A part it can't read counts as present;
 * over-reaching only costs a cache miss. */
export function reacher(html: string): (selector: string) => boolean {
  const classes = new Set(
    [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)),
  );
  const tags = new Set(
    [...html.matchAll(/<([a-z][a-z0-9-]*)/g)].map((m) => m[1]!),
  );
  return (selector) =>
    selector.split(",").some((alt) =>
      alt.trim().split(/\s*>\s*|\s+/).every((part) => {
        const m = part.match(COMPOUND);
        return !m || ((!m[1] || tags.has(m[1])) &&
          m[2]!.split(".").slice(1).every((c) => classes.has(c)));
      })
    );
}

/** The styles one segment's layout depends on: base.css, the paged CSS and
 * the DOM rules that reach it. Font links are left out: a family changes
 * pages only through a `font-family` rule, whose text names it. */
export function segmentStyleHash(
  s: Segment,
  u: { baseCss: string; pagedCss: string; domRules: DomRule[] },
): string {
  const reaches = reacher(s.html);
  return hash([
    u.baseCss,
    u.pagedCss,
    ...u.domRules.filter((r) => reaches(r.selector)).map((r) => r.css),
  ]);
}

/** Names a segment's layout: its own text (wherever it sits in the
 * manuscript, whatever URL its images have this session), its styles
 * (`segmentStyleHash`), the page numbers it prints and the layout code. `pageNumbering` is left
 * out: assembly applies it, so a numbering change lays out nothing. */
export function segmentKey(
  s: Segment,
  segmentStyle: string,
  seed: Seed,
  imageUrls: Record<string, string>,
): string {
  return hash([
    tokenImages(shiftLines(s.html, -s.line), imageUrls),
    segmentStyle,
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
      // Let a tab with a newer version upgrade instead of blocking on us;
      // the next transaction opens the upgraded database.
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
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

// Deletes the segment rows no manifest names or keeps.
function sweep(s: Stores): void {
  const books = s.books.getAll();
  books.onsuccess = () => {
    const named = new Set(
      (books.result as CachedRender[]).flatMap((
        b,
      ) => [...b.segments.map((x) => x.key), ...b.kept ?? []]),
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

/** Saves the manifest and `rows` (segment key → row), then, when the book
 * names other keys than before, sweeps rows no manifest names. The keys the
 * old manifest named are kept a while (`kept`, at most KEEP), so an undo hits. */
export async function saveCachedRender(
  id: string,
  render: CachedRender,
  rows: Map<string, CachedSegment>,
): Promise<void> {
  await transact("readwrite", (s) => {
    const old = s.books.get(id);
    old.onsuccess = () => {
      const was = old.result as CachedRender | undefined;
      const now = new Set(render.segments.map((x) => x.key));
      const kept = [
        ...new Set([
          ...was?.segments.map((x) => x.key) ?? [],
          ...was?.kept ?? [],
        ]),
      ].filter((k) => !now.has(k)).slice(0, KEEP);
      s.books.put({ ...render, kept }, id);
      for (const [key, row] of rows) s.segments.put(row, key);
      // Same keys as before: no row lost its name, so there's nothing to sweep.
      const same = was?.segments.length === now.size &&
        was.segments.every((x) => now.has(x.key));
      if (!same) sweep(s);
    };
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
