// server/store.ts — where a library's files live. Everything above this
// (pipeline, book service, exports) reads and writes books only through a
// BookStore, so the same code runs over a folder on disk (the Deno server, the
// CLI, later the desktop app) or a directory handle in the browser
// (web/src/fs-store.ts: the File System Access API, or origin-private storage).
// Paths are relative to the library root: "<book>/manuscript.md",
// "<book>/editions/<slug>.json", "<book>/images/<file>".
import { watchTree } from "./watch.ts";

export interface BookStore {
  /** Book slugs: directories with a manuscript.md, sorted. */
  list(): Promise<string[]>;
  /** File bytes, or null when missing. */
  read(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Replace the file (never a half-written one); its directory must exist. */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** A new file, creating its directories; false (and nothing written)
   * when it exists. */
  create(path: string, data: string | Uint8Array): Promise<boolean>;
  /** False when `from` is missing. */
  rename(from: string, to: string): Promise<boolean>;
  /** False when missing. */
  remove(path: string): Promise<boolean>;
  /** Names of the files directly in `dir`; [] when it doesn't exist. */
  listDir(dir: string): Promise<string[]>;
  /** Every change, as relative paths: this store's own writes, creates,
   * renames and removes, and other writers' (an editor, the CLI) where the
   * store can see them. Returns stop. */
  watch(onChange: (paths: string[]) => void): () => void;
}

const encoder = new TextEncoder();
export const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

/** Deno callers pass a folder; the browser passes its own store. */
export function asStore(root: string | BookStore): BookStore {
  return typeof root === "string" ? diskStore(root) : root;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

export function diskStore(root: string): BookStore {
  const full = (path: string) => `${root}/${path}`;
  const missing = (e: unknown) => e instanceof Deno.errors.NotFound;
  // Readers see the old file or the new one, never half a write; the watcher
  // ignores the .tmp name (classifyChange). The tmp name is unique, so two
  // writes to one path never share (and rename away) each other's tmp file.
  async function write(path: string, data: string | Uint8Array) {
    const tmp = `${full(path)}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(tmp, toBytes(data));
    await Deno.rename(tmp, full(path));
  }
  const store: BookStore = {
    async list() {
      const books: string[] = [];
      for await (const e of Deno.readDir(root)) {
        if (e.isDirectory && await store.exists(`${e.name}/manuscript.md`)) {
          books.push(e.name);
        }
      }
      return books.sort();
    },
    async read(path) {
      try {
        return await Deno.readFile(full(path));
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async readText(path) {
      const bytes = await store.read(path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async exists(path) {
      try {
        await Deno.stat(full(path));
        return true;
      } catch {
        return false;
      }
    },
    write,
    async create(path, data) {
      await Deno.mkdir(full(parentOf(path)), { recursive: true });
      try {
        await Deno.writeFile(full(path), toBytes(data), { createNew: true });
        return true;
      } catch (e) {
        if (e instanceof Deno.errors.AlreadyExists) return false;
        throw e;
      }
    },
    async rename(from, to) {
      try {
        await Deno.rename(full(from), full(to));
        return true;
      } catch (e) {
        if (missing(e)) return false;
        throw e;
      }
    },
    async remove(path) {
      try {
        await Deno.remove(full(path));
        return true;
      } catch (e) {
        if (missing(e)) return false;
        throw e;
      }
    },
    async listDir(dir) {
      const names: string[] = [];
      try {
        for await (const e of Deno.readDir(full(dir))) {
          if (e.isFile) names.push(e.name);
        }
      } catch (e) {
        if (!missing(e)) throw e;
      }
      return names.sort();
    },
    watch(onChange) {
      // fs events see this store's own writes like anyone else's. watchFs reports resolved absolute paths (on macOS /var/… is realpathed
      // to /private/var/…), so map events back through the root's realpath.
      const abs = Deno.realPathSync(root) + "/";
      const w = watchTree(root, (paths) =>
        onChange(
          paths.filter((p) => p.startsWith(abs)).map((p) =>
            p.slice(abs.length)
          ),
        ));
      return () => w.stop();
    },
  };
  return store;
}

/** The store for one tab of several over one library (the browser, where a
 * store sees only its own writes): what it writes is posted on a
 * BroadcastChannel named `channel`, and its watch hears the other tabs' posts
 * too — the dev server's fs watcher, between tabs. */
export function withTabs(store: BookStore, channel: string): BookStore {
  // A channel per post: delivery is queued when posted, so closing at once
  // loses nothing, and there is nothing left open to close.
  const post = (...paths: string[]) => {
    const c = new BroadcastChannel(channel);
    c.postMessage(paths);
    c.close();
  };
  return {
    ...store,
    async write(path, data) {
      await store.write(path, data);
      post(path);
    },
    async create(path, data) {
      const made = await store.create(path, data);
      if (made) post(path);
      return made;
    },
    async rename(from, to) {
      const moved = await store.rename(from, to);
      if (moved) post(from, to);
      return moved;
    },
    async remove(path) {
      const removed = await store.remove(path);
      if (removed) post(path);
      return removed;
    },
    watch(onChange) {
      const stop = store.watch(onChange);
      // A channel never hears its own posts, so this is only other tabs.
      const c = new BroadcastChannel(channel);
      c.onmessage = (e: MessageEvent) => {
        if (Array.isArray(e.data)) onChange(e.data.map(String));
      };
      return () => {
        stop();
        c.close();
      };
    },
  };
}
