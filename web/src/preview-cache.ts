// web/src/preview-cache.ts — pure hash + IndexedDB store for one cached render per book+edition.

export interface CachedRender {
  hash: string;
  pages: string;
  styles: string[];
  fontLinks: string;
}

const DB_NAME = "preview-cache";
const STORE = "renders";
const SEP = "\x1f"; // ASCII unit separator; cannot appear in HTML/CSS.

export async function renderHash(
  u: {
    html: string;
    baseCss: string;
    domCss: string;
    pagedCss: string;
    fontLinks: string;
  },
): Promise<string> {
  const text = [u.html, u.baseCss, u.domCss, u.pagedCss, u.fontLinks].join(SEP);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function cacheId(book: string, edition: string | null): string {
  return `${book}|${edition ?? ""}`;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
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
