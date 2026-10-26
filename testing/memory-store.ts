// testing/memory-store.ts — a BookStore over a Map of path → bytes, for
// tests. Directories are implied by the paths in it. Two stores given one Map
// share their files; each reports only its own writes, synchronously.
import { type BookStore, toBytes } from "../server/store.ts";

export function memoryStore(
  files: Map<string, Uint8Array> = new Map(),
): BookStore {
  const listeners = new Set<(paths: string[]) => void>();
  const changed = (...paths: string[]) => {
    for (const l of listeners) l(paths);
  };
  // Copies in and out, so a caller's array never aliases the stored one.
  const put = (path: string, data: string | Uint8Array) =>
    files.set(path, new Uint8Array(toBytes(data)));
  const namesIn = (prefix: string) =>
    [...files.keys()].filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length));
  const store: BookStore = {
    list: () =>
      Promise.resolve(
        namesIn("").filter((p) => /^[^/]+\/manuscript\.md$/.test(p))
          .map((p) => p.slice(0, p.indexOf("/"))).sort(),
      ),
    read(path) {
      const bytes = files.get(path);
      return Promise.resolve(bytes ? new Uint8Array(bytes) : null);
    },
    async readText(path) {
      const bytes = await store.read(path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    exists: (path) => Promise.resolve(files.has(path)),
    write(path, data) {
      put(path, data);
      changed(path);
      return Promise.resolve();
    },
    create(path, data) {
      if (files.has(path)) return Promise.resolve(false);
      put(path, data);
      changed(path);
      return Promise.resolve(true);
    },
    rename(from, to) {
      const bytes = files.get(from);
      if (!bytes) return Promise.resolve(false);
      files.delete(from);
      files.set(to, bytes);
      changed(from, to);
      return Promise.resolve(true);
    },
    remove(path) {
      if (!files.delete(path)) return Promise.resolve(false);
      changed(path);
      return Promise.resolve(true);
    },
    listDir: (dir) =>
      Promise.resolve(
        namesIn(`${dir}/`).filter((n) => !n.includes("/")).sort(),
      ),
    watch(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return store;
}
