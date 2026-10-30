// server/history.ts — a book's version history, pure over a BookStore so it
// runs in Deno and in the browser. Content-addressed and deduplicated:
//   <book>/.history/objects/<sha256 hex of raw bytes>  deflated file bytes
//   <book>/.history/versions/<id>.json                 a Version
// The id is the ISO time with ":" → "-", so file names sort by time.
import { deflateSync, inflateSync } from "fflate";
import type { BookStore } from "./store.ts";
import { diffText } from "./history-diff.ts";

export type SnapshotReason =
  | "idle"
  | "max"
  | "open"
  | "close"
  | "before-import"
  | "before-delete-edition"
  | "before-reload"
  | "before-restore"
  | "named";

export interface Version {
  id: string;
  at: string;
  reason: SnapshotReason;
  name?: string;
  /** Book-relative path → sha256 hex of its bytes. */
  files: Record<string, string>;
  changes: {
    text: boolean;
    chapters: string[];
    images: boolean;
    /** null = metadata.json, a slug = editions/<slug>.json. */
    editions: (string | null)[];
  };
}

export type RestoreScope = "all" | "text" | {
  edition: string | null;
};

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const IDLE_MS = 3 * MIN;
export const MAX_GAP_MS = 20 * MIN;
export const KEEP_ALL_MS = DAY;
export const KEEP_HOURLY_MS = 7 * DAY;
export const KEEP_DAILY_MS = 30 * DAY;

const SNAPSHOTTED =
  /^(manuscript\.md|metadata\.json|dictionary\.json|editions\/[^/]+\.json|images\/[^/]+)$/;
const isStyle = (rel: string) =>
  rel === "metadata.json" || /^editions\/[^/]+\.json$/.test(rel);
const editionOf = (rel: string) =>
  rel === "metadata.json"
    ? null
    : rel.slice("editions/".length, -".json".length);

const objectPath = (book: string, hash: string) =>
  `${book}/.history/objects/${hash}`;
const versionPath = (book: string, id: string) =>
  `${book}/.history/versions/${id}.json`;

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The book's snapshotted files as they are now, book-relative. */
async function currentFiles(
  store: BookStore,
  book: string,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const rels = ["manuscript.md", "metadata.json", "dictionary.json"];
  for (const dir of ["editions", "images"]) {
    for (const n of await store.listDir(`${book}/${dir}`)) {
      rels.push(`${dir}/${n}`);
    }
  }
  for (const rel of rels) {
    if (!SNAPSHOTTED.test(rel)) continue;
    const bytes = await store.read(`${book}/${rel}`);
    if (bytes) out.set(rel, bytes);
  }
  return out;
}

async function hashAll(
  files: Map<string, Uint8Array>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [rel, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
    out[rel] = await sha256(bytes);
  }
  return out;
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export async function readObject(
  store: BookStore,
  book: string,
  hash: string,
): Promise<Uint8Array | null> {
  const raw = await store.read(objectPath(book, hash));
  return raw ? inflateSync(raw) : null;
}

async function readText(store: BookStore, book: string, hash?: string) {
  const bytes = hash ? await readObject(store, book, hash) : null;
  return bytes ? new TextDecoder().decode(bytes) : "";
}

export async function listVersions(
  store: BookStore,
  book: string,
): Promise<Version[]> {
  const ids = (await store.listDir(`${book}/.history/versions`))
    .filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5))
    .sort().reverse();
  const out: Version[] = [];
  for (const id of ids) {
    const text = await store.readText(versionPath(book, id));
    if (text) out.push(JSON.parse(text) as Version);
  }
  return out;
}

/** One version by id, read straight from its file; null when absent. */
export async function readVersion(
  store: BookStore,
  book: string,
  id: string,
): Promise<Version | null> {
  const text = await store.readText(versionPath(book, id));
  return text ? JSON.parse(text) as Version : null;
}

export async function snapshot(
  store: BookStore,
  book: string,
  reason: SnapshotReason,
  opts: {
    name?: string;
    overrides?: Record<string, string>;
    now?: Date;
  } = {},
): Promise<Version | null> {
  const now = opts.now ?? new Date();
  const current = await currentFiles(store, book);
  const enc = new TextEncoder();
  for (const [rel, text] of Object.entries(opts.overrides ?? {})) {
    current.set(rel, enc.encode(text));
  }
  const files = await hashAll(current);
  const versions = await listVersions(store, book);
  const prev = versions[0];
  const before = prev?.files ?? {};
  if (prev && sameFiles(before, files)) {
    if (reason !== "named" || opts.name === undefined) return null;
    // A name is never overwritten: a named version gets a named twin instead.
    if (prev.name === undefined) {
      await nameVersion(store, book, prev.id, opts.name);
      return { ...prev, name: opts.name };
    }
  }

  const stored = new Set(Object.values(before));
  for (const [rel, hash] of Object.entries(files)) {
    const path = objectPath(book, hash);
    if (stored.has(hash) || await store.exists(path)) continue;
    await store.create(path, deflateSync(current.get(rel)!));
  }

  const differs = (rel: string) => before[rel] !== files[rel];
  const all = [...new Set([...Object.keys(before), ...Object.keys(files)])];
  const text = differs("manuscript.md");
  const chapters = text
    ? [
      ...new Set(
        diffText(
          await readText(store, book, before["manuscript.md"]),
          await readText(store, book, files["manuscript.md"]),
        ).map((c) => c.chapter),
      ),
    ]
    : [];
  const v: Version = {
    id: "",
    at: now.toISOString(),
    reason,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    files,
    changes: {
      text,
      chapters,
      images: all.some((r) => r.startsWith("images/") && differs(r)),
      editions: all.filter((r) => isStyle(r) && differs(r)).map(editionOf),
    },
  };
  const base = v.at.replaceAll(":", "-");
  for (let n = 1;; n++) {
    v.id = n === 1 ? base : `${base}-${n}`;
    if (await store.create(versionPath(book, v.id), JSON.stringify(v))) break;
  }
  // ponytail: prune runs in the same call, so it can't race this snapshot's
  // objects; two snapshotting writers on one book would need a lock.
  await prune(store, book, now, [v, ...versions]);
  return v;
}

export async function nameVersion(
  store: BookStore,
  book: string,
  id: string,
  name: string,
): Promise<void> {
  const path = versionPath(book, id);
  const text = await store.readText(path);
  if (text === null) throw new Error(`no version ${id}`);
  await store.write(path, JSON.stringify({ ...JSON.parse(text), name }));
}

/** A read-only store that serves `v`'s files at their normal paths. */
export function versionStore(
  store: BookStore,
  book: string,
  v: Version,
): BookStore {
  const own = (path: string) => {
    if (!path.startsWith(`${book}/`)) return null;
    const rel = path.slice(book.length + 1);
    return SNAPSHOTTED.test(rel) ? rel : null;
  };
  const readOnly = () =>
    Promise.reject(new Error("version store is read-only"));
  const read = async (path: string) => {
    const rel = own(path);
    if (rel === null) return store.read(path);
    const hash = v.files[rel];
    const bytes = hash ? await readObject(store, book, hash) : null;
    return bytes ? new Uint8Array(bytes) : null;
  };
  return {
    list: () => store.list(),
    read,
    async readText(path) {
      const bytes = await read(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    exists(path) {
      const rel = own(path);
      return rel === null
        ? store.exists(path)
        : Promise.resolve(rel in v.files);
    },
    listDir(dir) {
      const sub = ["editions", "images"].find((d) => dir === `${book}/${d}`);
      if (!sub) return store.listDir(dir);
      return Promise.resolve(
        Object.keys(v.files).filter((r) => r.startsWith(`${sub}/`))
          .map((r) => r.slice(sub.length + 1)).sort(),
      );
    },
    write: readOnly,
    create: readOnly,
    rename: readOnly,
    remove: readOnly,
    watch: () => () => {},
  };
}

/** Puts `v`'s files for `scope` back; returns the library-relative paths changed. */
export async function restore(
  store: BookStore,
  book: string,
  v: Version,
  scope: RestoreScope,
): Promise<string[]> {
  const now = await hashAll(await currentFiles(store, book));
  const all = [...new Set([...Object.keys(now), ...Object.keys(v.files)])];
  const targets = scope === "all"
    ? all
    : scope === "text"
    ? ["manuscript.md"]
    : [
      scope.edition === null
        ? "metadata.json"
        : `editions/${scope.edition}.json`,
    ];
  const changed: string[] = [];
  for (const rel of targets.sort()) {
    const path = `${book}/${rel}`;
    const want = v.files[rel];
    if (want === now[rel]) continue;
    if (want === undefined) {
      if (await store.remove(path)) changed.push(path);
      continue;
    }
    const bytes = await readObject(store, book, want);
    if (!bytes) throw new Error(`history object ${want} is missing`);
    if (!await store.create(path, bytes)) await store.write(path, bytes);
    changed.push(path);
  }
  return changed;
}

/** ISO week bucket: the UTC date of that week's Monday. */
const weekOf = (t: number) => {
  const d = new Date(t);
  return new Date(t - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(
    0,
    10,
  );
};

/** Ids of the versions the keep policy drops. Named versions always stay. */
export function thin(versions: Version[], now: Date): string[] {
  // ponytail: buckets are UTC hours/days/weeks, not the author's local ones.
  const seen = new Set<string>();
  const drop: string[] = [];
  const newestFirst = [...versions].sort((a, b) => a.id < b.id ? 1 : -1);
  for (const v of newestFirst) {
    if (v.name !== undefined) continue;
    const t = Date.parse(v.at);
    const age = now.getTime() - t;
    if (age < KEEP_ALL_MS) continue;
    const key = age < KEEP_HOURLY_MS
      ? `h${v.at.slice(0, 13)}`
      : age < KEEP_DAILY_MS
      ? `d${v.at.slice(0, 10)}`
      : `w${weekOf(t)}`;
    if (seen.has(key)) drop.push(v.id);
    else seen.add(key);
  }
  return drop;
}

/** Drops thinned versions, then objects no version references. */
export async function prune(
  store: BookStore,
  book: string,
  now: Date,
  versions: Version[],
): Promise<void> {
  const drop = new Set(thin(versions, now));
  for (const id of drop) await store.remove(versionPath(book, id));
  const live = new Set(
    versions.filter((v) => !drop.has(v.id)).flatMap((v) =>
      Object.values(v.files)
    ),
  );
  for (const hash of await store.listDir(`${book}/.history/objects`)) {
    if (!live.has(hash)) await store.remove(objectPath(book, hash));
  }
}
