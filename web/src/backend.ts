// web/src/backend.ts — what the app talks to. Over HTTP + a WebSocket it is
// the dev server (which runs the BookService over books/ on disk); without
// a server (the hosted site) the app runs the same BookService itself, over
// the author's own folder (fs-store.ts). app.ts never knows which.
import type { BuildResult, ServerMessage } from "../../server/pipeline.ts";
import type { Version } from "../../server/history.ts";
import type { Metadata } from "../../metadata/types.ts";
import type { HistoryBackend } from "./history-view.ts";
import type { EditionInfo } from "../../server/editions.ts";
import {
  BookService,
  libraryId,
  type MetadataResult,
  type SaveResult,
  ServiceError,
  themedTemplate,
} from "../../server/book-service.ts";
import { type BookStore, withTabs } from "../../server/store.ts";
import { handleStore } from "./fs-store.ts";
import type { ImageFile } from "../../server/images.ts";
import type { EpubResult } from "./style-catalog.ts";

export interface Backend extends HistoryBackend {
  readonly kind: "http" | "local";
  /** The folder the service runs over; only in-page (the app zips from it). */
  readonly store?: BookStore;
  /** The books, and the folders skipped for their names (BookService.list). */
  listBooks(): Promise<{ books: string[]; skipped: string[] }>;
  /** The library's id (BookService.libraryId). */
  libraryId(): Promise<string>;
  /** `theme`: a preset's slug (spec §4.13); none is House. */
  createBook(slug: string, title?: string, theme?: string): Promise<void>;
  /** A book from an import run in the page (§7.9). */
  importBook(
    slug: string,
    r: { manuscript: string; images: Record<string, Uint8Array> },
    theme?: string,
  ): Promise<void>;
  editions(book: string): Promise<EditionInfo[]>;
  manuscript(book: string): Promise<{ text: string; version: string }>;
  saveManuscript(
    book: string,
    save: { text: string; clientId: string; base: string | null },
  ): Promise<SaveResult>;
  metadata(book: string, edition: string | null): Promise<MetadataResult>;
  saveMetadata(
    book: string,
    edition: string | null,
    sections: object,
  ): Promise<{ version: string }>;
  /** A build in the given style, nothing saved (try on, spec §4.13). */
  tryBuild(
    book: string,
    edition: string | null,
    metadata: Metadata,
  ): Promise<BuildResult>;
  /** The book's spelling words (dictionary.json); addWord returns the list
   * after. */
  dictionary(book: string): Promise<string[]>;
  addWord(book: string, word: string): Promise<string[]>;
  /** The book's images, by slug (BookService.images). */
  images(book: string): Promise<ImageFile[]>;
  /** Puts the file in the book's images/ (BookService.addImage). */
  addImage(book: string, file: File, slug?: string): Promise<ImageFile>;
  /** Where the page shows an image, by its file name. */
  imageUrl(book: string, name: string): Promise<string>;
  /** `from`: "default" or a named edition's slug. */
  createEdition(book: string, slug: string, from: string): Promise<void>;
  renameEdition(book: string, edition: string, slug: string): Promise<void>;
  renameDefault(book: string, name: string): Promise<void>;
  deleteEdition(book: string, edition: string): Promise<void>;
  /** The e-book, as a link to open or save; `error` when it failed. */
  exportEpub(book: string, edition: string | null): Promise<EpubResult>;
  /** A build of the book as the version had it, painted like a live update. */
  buildVersion(
    book: string,
    id: string,
    edition: string | null,
  ): Promise<BuildResult>;
  takeSnapshot(
    book: string,
    reason: "close" | "before-reload",
    overrides?: Record<string, string>,
  ): Promise<Version | null>;
  /** Builds now and on every change; `onClose` when the server goes away. */
  subscribe(
    book: string,
    edition: string | null,
    clientId: string,
    onMessage: (m: ServerMessage) => void,
    onClose: () => void,
  ): () => void;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const editionsUrl = (book: string) =>
  `/api/books/${encodeURIComponent(book)}/editions`;
const metadataUrl = (book: string, edition: string | null) =>
  edition === null
    ? `/api/books/${encodeURIComponent(book)}/metadata`
    : `${editionsUrl(book)}/${encodeURIComponent(edition)}/metadata`;
const dictionaryUrl = (book: string) =>
  `/api/books/${encodeURIComponent(book)}/dictionary`;
const imagesUrl = (book: string) =>
  `/api/books/${encodeURIComponent(book)}/images`;
const historyUrl = (book: string) =>
  `/api/books/${encodeURIComponent(book)}/history`;
const query = (book: string, edition: string | null) =>
  `?book=${encodeURIComponent(book)}` +
  (edition === null ? "" : `&edition=${encodeURIComponent(edition)}`);

// A refusal carries its status, as the in-page service's do: Sync retries
// only what might go through next time.
async function answer<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ServiceError(res.status, await res.text());
  return res.status === 204 ? (undefined as T) : await res.json();
}
const call = async <T>(url: string, init?: RequestInit): Promise<T> =>
  answer<T>(await fetch(url, init));
const post = <T>(url: string, body: unknown) =>
  call<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export function httpBackend(): Backend {
  // A save outlives a tab closed right after it: keepalive, which the browser
  // allows only while every keepalive body in flight totals under 64 KB.
  // Past that a save goes plain and relies on the leave prompt.
  let keptAlive = 0; // keepalive body bytes in flight
  async function send(
    url: string,
    body: unknown,
    keep = true,
  ): Promise<Response> {
    const json = JSON.stringify(body);
    const size = new TextEncoder().encode(json).length;
    const keepalive = keep && keptAlive + size < 65536;
    if (keepalive) keptAlive += size;
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json,
        keepalive,
      });
    } finally {
      if (keepalive) keptAlive -= size;
    }
  }
  return {
    kind: "http",
    listBooks: () => call("/api/books"),
    libraryId: () => call<{ id: string }>("/api/library").then((r) => r.id),
    createBook: (slug, title, theme) =>
      post("/api/books", { slug, title, theme }),
    importBook: (slug, r, theme) =>
      post(`/api/books/${encodeURIComponent(slug)}/import`, {
        theme,
        manuscript: r.manuscript,
        images: Object.fromEntries(
          Object.entries(r.images).map(([k, v]) => [k, base64(v)]),
        ),
      }),
    editions: (book) =>
      call<{ editions: EditionInfo[] }>(editionsUrl(book)).then((r) =>
        r.editions
      ),
    async manuscript(book) {
      const res = await fetch(
        `/api/books/${encodeURIComponent(book)}/manuscript`,
      );
      if (!res.ok) throw new Error(`manuscript load failed: ${res.status}`);
      return await res.json();
    },
    async saveManuscript(book, save) {
      const res = await send(
        `/api/books/${encodeURIComponent(book)}/manuscript`,
        save,
      );
      return res.status === 409 ? await res.json() : await answer(res);
    },
    async metadata(book, edition) {
      const res = await fetch(metadataUrl(book, edition));
      if (!res.ok) {
        throw new Error(
          `metadata load failed: ${res.status} ${await res.text()}`,
        );
      }
      return await res.json();
    },
    saveMetadata: async (book, edition, sections) =>
      answer(await send(metadataUrl(book, edition), { sections })),
    async tryBuild(book, edition, metadata) {
      const res = await fetch(
        `/api/books/${encodeURIComponent(book)}/try`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ edition, metadata }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },
    dictionary: (book) =>
      call<{ words: string[] }>(dictionaryUrl(book)).then((r) => r.words),
    addWord: (book, word) =>
      post<{ words: string[] }>(dictionaryUrl(book), { word }).then((r) =>
        r.words
      ),
    images: (book) =>
      call<{ images: ImageFile[] }>(imagesUrl(book)).then((r) => r.images),
    addImage: (book, file, slug) =>
      call<ImageFile>(
        `${imagesUrl(book)}?filename=${encodeURIComponent(file.name)}${
          slug === undefined ? "" : `&slug=${encodeURIComponent(slug)}`
        }`,
        { method: "POST", body: file },
      ),
    imageUrl: (book, name) =>
      Promise.resolve(
        `/books/${encodeURIComponent(book)}/images/${encodeURIComponent(name)}`,
      ),
    createEdition: (book, slug, from) =>
      post(editionsUrl(book), { slug, from }),
    renameEdition: (book, edition, slug) =>
      post(`${editionsUrl(book)}/${encodeURIComponent(edition)}/rename`, {
        slug,
      }),
    renameDefault: (book, name) =>
      post(`${editionsUrl(book)}/default/rename`, { name }),
    deleteEdition: (book, edition) =>
      call(`${editionsUrl(book)}/${encodeURIComponent(edition)}`, {
        method: "DELETE",
      }),
    async exportEpub(book, edition) {
      const q = edition === null
        ? ""
        : `?edition=${encodeURIComponent(edition)}`;
      const base = `/api/books/${encodeURIComponent(book)}`;
      const res = await fetch(`${base}/epub${q}`, { method: "POST" });
      if (!res.ok) return { error: await res.text() };
      const r = await res.json() as { file: string; documents: number };
      // A fresh query per export, so the viewer never shows a cached file.
      return {
        documents: r.documents,
        file: {
          name: r.file,
          url: `${base}/export/${encodeURIComponent(r.file)}${
            q ? `${q}&` : "?"
          }v=${Date.now()}`,
        },
      };
    },
    history: (book) => call(historyUrl(book)),
    versionFiles: (book, id) =>
      call(`${historyUrl(book)}/${encodeURIComponent(id)}`),
    buildVersion: (book, id, edition) =>
      call(
        `${historyUrl(book)}/${encodeURIComponent(id)}/build${
          edition === null ? "" : `?edition=${encodeURIComponent(edition)}`
        }`,
      ),
    restoreVersion: (book, id, scope) =>
      post(`${historyUrl(book)}/${encodeURIComponent(id)}/restore`, { scope }),
    nameVersion: (book, id, name) =>
      post(`${historyUrl(book)}/name`, { id, name }),
    // A closing tab's save goes in the same moment and owns the keepalive
    // budget: an unsaved buffer is as big as that save, so it goes plain.
    takeSnapshot: async (book, reason, overrides) =>
      answer(
        await send(
          `${historyUrl(book)}/snapshot`,
          { reason, overrides },
          !overrides,
        ),
      ),
    subscribe(book, edition, clientId, onMessage, onClose) {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${proto}://${location.host}/ws${
          query(book, edition)
        }&client=${clientId}`,
      );
      ws.onmessage = (e) => onMessage(JSON.parse(e.data));
      ws.onclose = onClose;
      return () => {
        ws.onclose = null;
        ws.close();
      };
    },
  };
}

const IMAGE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** The service in-page over the author's folder; `template` is a new book's
 * metadata.json, `baseCss` renderer/base.css (both fetched as static files).
 * Other tabs over the same library are other services on the same files:
 * named for its id, the tab channel carries each one's writes to the others
 * and the locks make a save's check + write atomic across them. */
export async function localBackend(
  root: FileSystemDirectoryHandle,
  assets: { baseCss: string; template: string },
): Promise<Backend> {
  const id = await libraryId(handleStore(root));
  // Kept as backend.store too, so the app's imports reach the other tabs.
  const store = withTabs(handleStore(root), `wynkyn:${id}`);
  const urls = new Map<string, string>(); // image path → object URL
  async function imageUrl(book: string, name: string): Promise<string> {
    const path = `${book}/images/${name}`;
    let url = urls.get(path);
    if (!url) {
      const bytes = await store.read(path);
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      // The name as a fragment (ignored on load): folios.js's printDpi tells
      // vector art by its extension.
      url = `${
        URL.createObjectURL(
          new Blob([bytes ?? new Uint8Array()], { type: IMAGE_TYPES[ext] }),
        )
      }#${name}`;
      urls.set(path, url); // ponytail: never revoked; an added image gets a new name, never new bytes
    }
    return url;
  }
  const service = new BookService({
    store,
    baseCss: assets.baseCss,
    imageUrl,
    lock: (key, fn) => navigator.locks.request(`${id}:${key}`, fn),
  });
  return {
    kind: "local",
    store,
    listBooks: () => service.list(),
    libraryId: () => service.libraryId(),
    async createBook(slug, title, theme) {
      const meta = themedTemplate(assets.template, theme);
      if (!await service.createBook(slug, meta, title)) {
        throw new Error("book already exists");
      }
    },
    async importBook(slug, r, theme) {
      const meta = themedTemplate(assets.template, theme);
      if (!await service.importBook(slug, meta, r)) {
        throw new Error("book already exists");
      }
    },
    editions: (book) => service.editions(book),
    manuscript: (book) => service.manuscript(book),
    saveManuscript: (book, save) => service.saveManuscript(book, save),
    metadata: (book, edition) => service.metadata(book, edition),
    saveMetadata: (book, edition, sections) =>
      service.saveMetadata(book, edition, sections),
    tryBuild: (book, edition, metadata) =>
      service.build(book, edition, metadata),
    dictionary: (book) => service.dictionary(book),
    addWord: (book, word) => service.addWord(book, word),
    images: (book) => service.images(book),
    addImage: async (book, file, slug) =>
      service.addImage(
        book,
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        slug,
      ),
    imageUrl,
    createEdition: (book, slug, from) =>
      service.createEdition(book, slug, from === "default" ? null : from),
    renameEdition: (book, edition, slug) =>
      service.renameEdition(book, edition, slug),
    renameDefault: (book, name) => service.renameDefault(book, name),
    deleteEdition: (book, edition) => service.deleteEdition(book, edition),
    async exportEpub(book, edition) {
      const { epub, documents } = await service.exportEpub(book, edition);
      const url = URL.createObjectURL(
        new Blob([epub], { type: "application/epub+zip" }),
      );
      return { documents, file: { name: "book.epub", url } };
    },
    history: (book) => service.history(book),
    versionFiles: (book, id) => service.versionFiles(book, id),
    buildVersion: (book, id, edition) =>
      service.buildVersion(book, id, edition),
    restoreVersion: (book, id, scope) =>
      service.restoreVersion(book, id, scope),
    nameVersion: (book, id, name) => service.nameVersion(book, id, name),
    takeSnapshot: (book, reason, overrides) =>
      service.takeSnapshot(book, reason, overrides),
    subscribe: (book, edition, clientId, onMessage) =>
      service.subscribe(book, edition, clientId, onMessage),
  };
}

/** The dev server when there is one, else the app runs the service itself. */
export async function hasServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/books");
    return res.ok &&
      (res.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

export async function localAssets(): Promise<
  { baseCss: string; template: string }
> {
  const [baseCss, template] = await Promise.all([
    fetch("/renderer/base.css").then((r) => r.text()),
    fetch("/templates/metadata.json").then((r) => r.text()),
  ]);
  return { baseCss, template };
}
