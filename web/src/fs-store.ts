// web/src/fs-store.ts — a BookStore over a browser directory handle: the
// author's own books/ folder through the File System Access API (Chromium),
// or the site's origin-private file system where that API is missing. Same
// handle API either way, so one store serves both.
import type { BookStore } from "../../server/store.ts";
import { slugify } from "./editions.ts";
import { bookFiles } from "./book-zip.ts";

declare global {
  interface FileSystemHandle {
    queryPermission(
      d?: { mode?: "read" | "readwrite" },
    ): Promise<PermissionState>;
    requestPermission(
      d?: { mode?: "read" | "readwrite" },
    ): Promise<PermissionState>;
  }
  function showDirectoryPicker(
    o?: { mode?: "read" | "readwrite"; id?: string },
  ): Promise<FileSystemDirectoryHandle>;
}

const encoder = new TextEncoder();
const isMissing = (e: unknown) =>
  e instanceof DOMException &&
  (e.name === "NotFoundError" || e.name === "TypeMismatchError");

export function handleStore(root: FileSystemDirectoryHandle): BookStore {
  // The directory holding `path`; null when missing and not creating.
  async function dirOf(
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    let dir = root;
    for (const part of path.split("/").slice(0, -1)) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    }
    return dir;
  }
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  async function fileOf(path: string): Promise<FileSystemFileHandle | null> {
    const dir = await dirOf(path, false);
    if (!dir) return null;
    try {
      return await dir.getFileHandle(nameOf(path));
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }
  async function put(
    dir: FileSystemDirectoryHandle,
    path: string,
    data: string | Uint8Array,
  ) {
    const fh = await dir.getFileHandle(nameOf(path), { create: true });
    // createWritable writes a swap file and swaps it in on close: readers
    // never see a half-written file, like the disk store's tmp + rename.
    const w = await fh.createWritable();
    // A fresh copy: the handle API wants a view over a plain ArrayBuffer.
    await w.write(
      typeof data === "string" ? encoder.encode(data) : new Uint8Array(data),
    );
    await w.close();
  }
  async function listDir(dir: string): Promise<string[]> {
    const names: string[] = [];
    let d: FileSystemDirectoryHandle | null;
    try {
      d = await dirOf(`${dir}/x`, false);
    } catch {
      return [];
    }
    if (!d) return [];
    for await (const [name, h] of d.entries()) {
      if (h.kind === "file") names.push(name);
    }
    return names.sort();
  }
  // No fs events in the browser: the store reports its own changes.
  const listeners = new Set<(paths: string[]) => void>();
  const changed = (...paths: string[]) => {
    for (const l of listeners) l(paths);
  };
  async function remove(path: string): Promise<boolean> {
    const dir = await dirOf(path, false);
    if (!dir) return false;
    try {
      await dir.removeEntry(nameOf(path));
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }
  const store: BookStore = {
    async list() {
      const books: string[] = [];
      for await (const [name, h] of root.entries()) {
        if (
          h.kind === "directory" && await store.exists(`${name}/manuscript.md`)
        ) {
          books.push(name);
        }
      }
      return books.sort();
    },
    async read(path) {
      const fh = await fileOf(path);
      if (!fh) return null;
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    },
    async readText(path) {
      const fh = await fileOf(path);
      return fh ? await (await fh.getFile()).text() : null;
    },
    async exists(path) {
      return (await fileOf(path)) !== null;
    },
    async write(path, data) {
      const dir = await dirOf(path, false);
      if (!dir) throw new Error(`no such directory for ${path}`);
      await put(dir, path, data);
      changed(path);
    },
    async create(path, data) {
      if (await store.exists(path)) return false;
      await put((await dirOf(path, true))!, path, data);
      changed(path);
      return true;
    },
    async rename(from, to) {
      // ponytail: copy + delete; FileSystemHandle.move() is Chromium-only.
      const data = await store.read(from);
      if (data === null) return false;
      await put((await dirOf(to, true))!, to, data);
      await remove(from);
      changed(from, to);
      return true;
    },
    async remove(path) {
      if (!await remove(path)) return false;
      changed(path);
      return true;
    },
    listDir,
    watch(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return store;
}

// ---- which folder --------------------------------------------------------

export const rememberFolder = (dir: FileSystemDirectoryHandle): Promise<
  IDBValidKey
> => idb("readwrite", (s) => s.put(dir, "library"));

/** The author's books/ folder, remembered across reloads in IndexedDB. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const dir = await showDirectoryPicker({ mode: "readwrite", id: "books" });
  await rememberFolder(dir);
  return dir;
}

/** A new "Books" folder inside a folder the user picks, remembered like a
 * picked one. The picker has no "create here" mode, so this is two steps. */
export async function createBooksFolder(): Promise<FileSystemDirectoryHandle> {
  const parent = await showDirectoryPicker({ mode: "readwrite", id: "books" });
  const dir = await parent.getDirectoryHandle("Books", { create: true });
  await rememberFolder(dir);
  return dir;
}

export async function rememberedFolder(): Promise<
  FileSystemDirectoryHandle | null
> {
  try {
    const dir = await idb<FileSystemDirectoryHandle | undefined>(
      "readonly",
      (s) => s.get("library"),
    );
    return dir ?? null;
  } catch {
    return null; // storage blocked: the author picks the folder again
  }
}

/** True once this page may write the remembered folder (asks on a gesture). */
export async function reopenFolder(
  dir: FileSystemDirectoryHandle,
  ask: boolean,
): Promise<boolean> {
  const mode = { mode: "readwrite" } as const;
  if ((await dir.queryPermission(mode)) === "granted") return true;
  return ask && (await dir.requestPermission(mode)) === "granted";
}

export const browserFolder = (): Promise<FileSystemDirectoryHandle> =>
  navigator.storage.getDirectory();

// Files picked with <input type="file" webkitdirectory>: every book is a
// directory with a manuscript.md; its metadata, editions, images and
// history come along, anything else is left behind. A book is named by its folder,
// slugified; a slug the library already has (or this import already took) is
// skipped whole, never merged or overwritten. Returns the slugs written and
// the folder names skipped.
export async function importBooks(
  store: BookStore,
  files: FileList | File[],
): Promise<{ written: string[]; skipped: string[] }> {
  const roots = new Set<string>(); // "…/<book>" for each manuscript.md
  for (const f of files) {
    const p = f.webkitRelativePath || f.name;
    if (p.endsWith("/manuscript.md")) {
      roots.add(p.slice(0, -"/manuscript.md".length));
    } else if (p === "manuscript.md") roots.add("");
  }
  const slugs = new Map<string, string>(); // root → slug, for those kept
  const skipped: string[] = [];
  for (const root of [...roots].sort()) {
    const name = root === "" ? "book" : root.slice(root.lastIndexOf("/") + 1);
    const slug = slugify(name) || "book";
    const taken = [...slugs.values()].includes(slug) ||
      await store.exists(`${slug}/manuscript.md`);
    if (taken) skipped.push(name);
    else slugs.set(root, slug);
  }
  const written = new Set<string>();
  for (const f of files) {
    const p = f.webkitRelativePath || f.name;
    const root = [...roots].find((r) => r === "" || p.startsWith(r + "/"));
    if (root === undefined) continue;
    const book = slugs.get(root);
    if (book === undefined) continue; // skipped
    const rel = root === "" ? p : p.slice(root.length + 1);
    if (
      !/^(manuscript\.md|metadata\.json|editions\/[^/]+\.json|images\/[^/]+|\.history\/(objects|versions)\/[^/]+)$/
        .test(rel)
    ) continue;
    const path = `${book}/${rel}`;
    const data = new Uint8Array(await f.arrayBuffer());
    if (!await store.create(path, data)) await store.write(path, data);
    written.add(book);
  }
  return { written: [...written].sort(), skipped };
}

// A slug `to` already has is skipped whole, never merged.
export async function copyBooks(
  from: BookStore,
  to: BookStore,
  books: string[],
): Promise<{ copied: string[]; skipped: string[] }> {
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const book of books) {
    if (await to.exists(`${book}/manuscript.md`)) {
      skipped.push(book);
      continue;
    }
    for (const rel of await bookFiles(from, book, true)) {
      const data = await from.read(`${book}/${rel}`);
      if (data) await to.create(`${book}/${rel}`, data);
    }
    copied.push(book);
  }
  return { copied, skipped };
}

function idb<T>(
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("wynkyn", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = op(tx.objectStore("handles"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}
