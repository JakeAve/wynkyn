// web/src/preview-cache.ts — pure hash + IndexedDB store for one cached render per book+edition.
import type { PageProblem, Seed } from "../../renderer/page-map-types.ts";

export interface CachedRender {
  hash: string;
  pages: string;
  styles: string[];
  fontLinks: string;
  // Rows saved before the page map lack these two.
  seed: Seed;
  problems: PageProblem[];
}

const DB_NAME = "preview-cache";
const STORE = "renders";
const SEP = "\x1f"; // ASCII unit separator; cannot appear in HTML/CSS.

// cyrb53: a fast non-cryptographic 53-bit string hash. Sync and available on
// plain http over a LAN IP, where crypto.subtle is undefined.
export function renderHash(
  u: {
    html: string;
    baseCss: string;
    domCss: string;
    pagedCss: string;
    fontLinks: string;
    // Folio styles no longer show up in pagedCss; they change the render too.
    pageNumbering?: unknown;
  },
): string {
  const text = [
    u.html,
    u.baseCss,
    u.domCss,
    u.pagedCss,
    u.fontLinks,
    JSON.stringify(u.pageNumbering ?? null),
  ].join(SEP);
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

export function cacheId(book: string, edition: string | null): string {
  return `${book}|${edition ?? ""}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

export async function loadCachedRender(
  id: string,
): Promise<CachedRender | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveCachedRender(
  id: string,
  r: CachedRender,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(r, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Courtesy cleanup when an edition is renamed or deleted; an orphan row is
// never read, it just takes up space until the browser evicts it.
export async function deleteCachedRender(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
