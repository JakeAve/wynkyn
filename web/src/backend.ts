// web/src/backend.ts — what the app talks to. Over HTTP + a WebSocket it is
// the dev server (which runs the BookService over books/ on disk); without
// a server (the hosted site) the app runs the same BookService itself, over
// the author's own folder (fs-store.ts). app.ts never knows which.
import type { ServerMessage } from "../../server/pipeline.ts";
import type { EditionInfo } from "../../server/editions.ts";
import {
  BookService,
  type MetadataResult,
  type SaveResult,
} from "../../server/book-service.ts";
import type { BookStore } from "../../server/store.ts";
import type { EpubResult } from "./style-catalog.ts";

export interface Backend {
  readonly kind: "http" | "local";
  /** The folder the service runs over; only in-page (the app zips from it). */
  readonly store?: BookStore;
  listBooks(): Promise<string[]>;
  /** The library's id (BookService.libraryId). */
  libraryId(): Promise<string>;
  createBook(slug: string, title?: string): Promise<void>;
  /** A book from an import run in the page (§7.9). */
  importBook(
    slug: string,
    r: { manuscript: string; images: Record<string, Uint8Array> },
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
  /** `from`: "default" or a named edition's slug. */
  createEdition(book: string, slug: string, from: string): Promise<void>;
  renameEdition(book: string, edition: string, slug: string): Promise<void>;
  renameDefault(book: string, name: string): Promise<void>;
  deleteEdition(book: string, edition: string): Promise<void>;
  /** The e-book, as a link to open or save; `error` when it failed. */
  exportEpub(book: string, edition: string | null): Promise<EpubResult>;
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
const query = (book: string, edition: string | null) =>
  `?book=${encodeURIComponent(book)}` +
  (edition === null ? "" : `&edition=${encodeURIComponent(edition)}`);

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? (undefined as T) : await res.json();
}
const post = <T>(url: string, body: unknown) =>
  call<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export function httpBackend(): Backend {
  return {
    kind: "http",
    listBooks: () =>
      call<{ books: string[] }>("/api/books").then((r) => r.books),
    libraryId: () => call<{ id: string }>("/api/library").then((r) => r.id),
    createBook: (slug, title) => post("/api/books", { slug, title }),
    importBook: (slug, r) =>
      post(`/api/books/${encodeURIComponent(slug)}/import`, {
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
      const res = await fetch(
        `/api/books/${encodeURIComponent(book)}/manuscript`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(save),
        },
      );
      if (res.status !== 409 && !res.ok) throw new Error(await res.text());
      return await res.json();
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
    saveMetadata: (book, edition, sections) =>
      post(metadataUrl(book, edition), { sections }),
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
 * metadata.json, `baseCss` renderer/base.css (both fetched as static files). */
export function localBackend(
  store: BookStore,
  assets: { baseCss: string; template: string },
): Backend {
  const urls = new Map<string, string>(); // image path → object URL
  const service = new BookService({
    store,
    baseCss: assets.baseCss,
    async imageUrl(book, name) {
      const path = `${book}/images/${name}`;
      let url = urls.get(path);
      if (!url) {
        const bytes = await store.read(path);
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        url = URL.createObjectURL(
          new Blob([bytes ?? new Uint8Array()], { type: IMAGE_TYPES[ext] }),
        );
        urls.set(path, url); // ponytail: never revoked; images don't change under the page
      }
      return url;
    },
  });
  return {
    kind: "local",
    store,
    listBooks: () => service.list(),
    libraryId: () => service.libraryId(),
    async createBook(slug, title) {
      if (!await service.createBook(slug, assets.template, title)) {
        throw new Error("book already exists");
      }
    },
    async importBook(slug, r) {
      if (!await service.importBook(slug, assets.template, r)) {
        throw new Error("book already exists");
      }
    },
    editions: (book) => service.editions(book),
    manuscript: (book) => service.manuscript(book),
    saveManuscript: (book, save) => service.saveManuscript(book, save),
    metadata: (book, edition) => service.metadata(book, edition),
    saveMetadata: (book, edition, sections) =>
      service.saveMetadata(book, edition, sections),
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
