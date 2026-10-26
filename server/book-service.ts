// server/book-service.ts — everything an editor does to a library, over a
// BookStore and independent of the runtime: list, build, save a manuscript
// against its version, merge metadata sections, manage editions, and push
// rebuilds to subscribed editors (spec §5.4, §6). Front doors: dev-server.ts
// puts HTTP + WebSockets in front of it; the browser app (web/src/backend.ts)
// calls it directly over its own folder; the desktop app will do the same.
import {
  buildBook,
  type BuildOptions,
  type BuildResult,
  contentVersion,
  imageFiles,
  NotFoundError,
  type ServerMessage,
} from "./pipeline.ts";
import { parseMetadataText } from "../metadata/loader.ts";
import type { Metadata } from "../metadata/types.ts";
import { applyTheme } from "../metadata/themes.ts";
import {
  classifyChange,
  createEdition,
  type EditionInfo,
  listEditions,
  metadataKey,
  renameOnlyToken,
  safeName,
} from "./editions.ts";
import type { BookStore } from "./store.ts";
import {
  freeSlug,
  IMAGE_EXTS,
  type ImageFile,
  imageSlug,
  safeImageName,
} from "./images.ts";
import { type EpubBytes, epubBytes } from "./epub-export.ts";

/** A refused request; `status` is the HTTP status the dev server answers with. */
export class ServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const bad = (message: string) => new ServiceError(400, message);
const notFound = (message: string) => new ServiceError(404, message);

export interface ServiceOptions {
  store: BookStore;
  baseCss?: string; // renderer/base.css; required in the browser
  imageUrl?: BuildOptions["imageUrl"];
}

export type SaveResult =
  | { ok: true; version: string; text?: string } // text: the save was rewritten
  | { conflict: true; text: string; version: string };

export interface MetadataResult {
  metadata: Metadata;
  version: string | null; // null: no metadata.json (metadata is optional, spec §4)
}

interface Client {
  send(m: ServerMessage): void;
  book: string;
  edition: string | null;
  clientId: string;
}

export class BookService {
  readonly store: BookStore;
  private readonly buildOpts: Pick<BuildOptions, "baseCss" | "imageUrl">;
  private readonly clients = new Set<Client>();
  // key → the tail of its work queue. Keys are a book (its manuscript: a
  // save's check + write, a rename's token rewrite), a metadata path (its
  // writes) or "<book>/images" (adds); safeName keeps a book apart from the
  // others, a path always has a "/".
  private readonly chains = new Map<string, Promise<void>>();
  // EXPERIMENTAL (§3.2.9): book → edition renames whose {only} token a stale
  // save may still carry (another tab, a debounced save not yet sent). Each
  // lasts until every client connected at the rename has sent a save without
  // the old token or disconnected.
  private readonly tokenRenames = new Map<
    string,
    { from: string; to: string; stale: Set<string> }[]
  >();
  private readonly stopWatch: () => void;
  // book → a rebuild held back after a change to images/ alone (onChanged).
  private readonly heldImages = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(opts: ServiceOptions) {
    this.store = opts.store;
    this.buildOpts = { baseCss: opts.baseCss, imageUrl: opts.imageUrl };
    // The store reports every change, the service's own writes included.
    this.stopWatch = this.store.watch((paths) => this.onChanged(paths));
  }

  async stop(): Promise<void> {
    this.stopWatch();
    for (const t of this.heldImages.values()) clearTimeout(t);
    await Promise.all(this.chains.values()); // writes under way land
    this.clients.clear();
  }

  // ---- reading ----------------------------------------------------------

  list(): Promise<string[]> {
    return this.store.list();
  }

  /** The library's id (`library.json`), minted on first ask. It lives with
   * the books, so it is the same from any browser or machine that opens this
   * folder; the app writes it into its URLs so a link from another library
   * can be told apart from one of ours. Random: it identifies, not protects. */
  async libraryId(): Promise<string> {
    const path = "library.json";
    try {
      const id = JSON.parse(await this.store.readText(path) ?? "{}").id;
      if (typeof id === "string" && id) return id;
    } catch {
      // unreadable file: replaced below
    }
    const fresh = crypto.randomUUID().slice(0, 8);
    await this.store.write(path, JSON.stringify({ id: fresh }) + "\n");
    return fresh; // ponytail: two tabs minting at once leaves one stale URL once
  }

  editions(book: string): Promise<EditionInfo[]> {
    return this.requireBook(book).then(() => listEditions(this.store, book));
  }

  /** Throws ServiceError 404 when the book or edition is missing. With
   * `metadata`, builds in that style and writes nothing (try on, spec §4.13). */
  async build(
    book: string,
    edition: string | null,
    metadata?: Metadata,
  ): Promise<BuildResult> {
    checkNames(book, edition);
    try {
      return await buildBook(this.store, book, {
        edition,
        metadata,
        ...this.buildOpts,
      });
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw notFound("book or edition not found");
      }
      throw err;
    }
  }

  async manuscript(book: string): Promise<{ text: string; version: string }> {
    checkNames(book, null);
    await this.chains.get(book); // a save under way lands first
    const text = await this.store.readText(`${book}/manuscript.md`);
    if (text === null) throw notFound("book not found");
    return { text, version: await contentVersion(text) };
  }

  image(book: string, file: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!safeName(book) || !safeImageName(file)) throw bad("bad path");
    return this.store.read(`${book}/images/${file}`);
  }

  /** The book's images in an accepted format, by slug. */
  async images(book: string): Promise<ImageFile[]> {
    checkNames(book, null);
    await this.requireBook(book);
    return Object.entries(await this.shownImages(book))
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  }

  // slug → file name, only the files the renderer can show: a harbour.tif
  // neither lists nor takes the slug from a harbour.png.
  private async shownImages(book: string): Promise<Record<string, string>> {
    return Object.fromEntries(
      Object.entries(await imageFiles(this.store, book)).filter(([, name]) =>
        IMAGE_EXTS.includes(name.slice(name.lastIndexOf(".") + 1).toLowerCase())
      ),
    );
  }

  async metadata(
    book: string,
    edition: string | null,
  ): Promise<MetadataResult> {
    checkNames(book, edition);
    await this.requireBook(book);
    await this.chains.get(metadataKey(book, edition)); // a save under way lands first
    const current = await this.readMetadata(book, edition);
    return {
      metadata: current.metadata as Metadata,
      version: current.text === null
        ? null
        : await contentVersion(current.text),
    };
  }

  /** The book's own spelling words (`dictionary.json`, spec §4.1); [] when
   * it has none. Throws 409 when the file is there but isn't a word list, so
   * addWord never writes over what the author typed. */
  async dictionary(book: string): Promise<string[]> {
    checkNames(book, null);
    await this.requireBook(book);
    const text = await this.store.readText(`${book}/dictionary.json`);
    if (text === null) return [];
    try {
      const { words } = JSON.parse(text);
      if (Array.isArray(words) && words.every((w) => typeof w === "string")) {
        return words;
      }
    } catch {
      // reported below
    }
    throw new ServiceError(409, 'dictionary.json is not { "words": [...] }');
  }

  // ---- writing ----------------------------------------------------------
  /** Adds one word to the book's dictionary.json; the list after. */
  async addWord(book: string, word: string): Promise<string[]> {
    if (!word || /\s/.test(word)) throw bad("one word, no spaces");
    const words = [...new Set([...await this.dictionary(book), word])]
      .sort((a, b) => a.localeCompare(b));
    // ponytail: read-then-write; two tabs adding at once can lose one word.
    await this.store.write(
      `${book}/dictionary.json`,
      JSON.stringify({ words }, null, 2) + "\n",
    );
    return words;
  }

  /** Puts a file in the book's images/, named for its file name (or `slug`),
   * never over an existing one. A slug is taken under any accepted extension:
   * the resolver serves the first match, so a second would be shadowed (a
   * file it can't show, harbour.tif, doesn't count). Without
   * `slug` a taken name gets -2, -3, …; with one, a taken slug is a 409. */
  async addImage(
    book: string,
    filename: string,
    bytes: Uint8Array,
    slug?: string,
  ): Promise<ImageFile> {
    checkNames(book, null);
    const parsed = imageSlug(filename);
    if (!parsed) {
      throw new ServiceError(
        415,
        "Only PNG, JPEG, WebP or SVG images can go in a book",
      );
    }
    if (slug !== undefined && !safeImageName(slug)) {
      throw bad("bad image name");
    }
    // In the folder's queue, so two adds never pick the same free name.
    return await this.serialize(`${book}/images`, async () => {
      await this.requireBook(book);
      const taken = new Set(Object.keys(await this.shownImages(book)));
      if (slug !== undefined && taken.has(slug)) {
        throw new ServiceError(409, "an image with that name is already there");
      }
      const name = `${slug ?? freeSlug(parsed.slug, taken)}.${parsed.ext}`;
      const path = `${book}/images/${name}`;
      if (!await this.store.create(path, bytes)) {
        throw new ServiceError(409, "an image with that name is already there");
      }
      return { slug: name.slice(0, -parsed.ext.length - 1), name };
    });
  }

  /** A new book from a template's metadata; false when the slug is taken. */
  async createBook(
    book: string,
    metadataText: string,
    title = book,
  ): Promise<boolean> {
    checkNames(book, null);
    const manuscript = `${book}/manuscript.md`;
    const made = await this.store.create(
      manuscript,
      `{matter: half-title}\n{title}\n${title.trim() || book}\n`,
    );
    if (!made) return false;
    await this.store.write(metadataKey(book, null), metadataText);
    return true;
  }

  /** A book from an import (spec §7.9): the manuscript, its images, and the
   * template's metadata; false when the slug is taken. */
  async importBook(
    book: string,
    metadataText: string,
    r: { manuscript: string; images: Record<string, Uint8Array> },
  ): Promise<boolean> {
    checkNames(book, null);
    const manuscript = `${book}/manuscript.md`;
    if (!await this.store.create(manuscript, r.manuscript)) return false;
    const meta = metadataKey(book, null);
    if (!await this.store.exists(meta)) {
      await this.store.write(meta, metadataText);
    }
    for (const [path, data] of Object.entries(r.images)) {
      if (!/^images\/[^/]+$/.test(path)) throw bad("bad image path");
      // create makes images/; write replaces a stray file already there
      const file = `${book}/${path}`;
      if (!await this.store.create(file, data)) {
        await this.store.write(file, data);
      }
    }
    return true;
  }

  // The client debounces and sends one save at a time, so a save lands before
  // it is answered: the check against `base` and the write run in the book's
  // queue, never interleaved with another save or a rename's rewrite.
  saveManuscript(
    book: string,
    save: { text: string; clientId?: string | null; base?: string | null },
  ): Promise<SaveResult> {
    checkNames(book, null);
    const clientId = save.clientId ?? null;
    const path = `${book}/manuscript.md`;
    return this.serialize(book, async () => {
      const current = await this.store.readText(path);
      if (current === null) throw notFound("book not found");
      // A save based on a version that is no longer current would overwrite
      // a change its editor never saw: refuse it with the current text. No
      // base (the CLI, old callers) skips the check.
      if (typeof save.base === "string") {
        const version = await contentVersion(current);
        if (version !== save.base) {
          return { conflict: true, text: current, version };
        }
      }
      // A save still carrying a renamed edition's old token gets the new
      // one, and the response hands the rewritten text back.
      let text = save.text;
      for (const r of this.tokenRenames.get(book) ?? []) {
        if (clientId !== null && !r.stale.has(clientId)) continue;
        const next = renameOnlyToken(text, r.from, r.to);
        if (next !== text) text = next;
        else if (clientId !== null) r.stale.delete(clientId); // caught up
      }
      this.pruneRenames(book);
      try {
        await this.store.write(path, text);
      } catch (err) {
        throw new ServiceError(500, `save failed: ${String(err)}`);
      }
      const version = await contentVersion(text);
      return text === save.text
        ? { ok: true, version }
        : { ok: true, version, text };
    });
  }

  /** Shallow-merges the sections into the edition's metadata file; resolves
   * with the version of what landed once it is written, rejects (500) when
   * the write fails. Merged onto the file as it is now, in the file's queue,
   * so another writer's edit to another section survives and a rename or
   * delete called after this waits for it. */
  saveMetadata(
    book: string,
    edition: string | null,
    sections: object,
  ): Promise<{ version: string }> {
    checkNames(book, edition);
    const path = metadataKey(book, edition);
    return this.serialize(path, async () => {
      await this.requireBook(book);
      const disk = await this.readMetadata(book, edition);
      const text = serializeMeta(mergeSections(disk.metadata, sections));
      try {
        await this.store.write(path, text);
      } catch (err) {
        throw new ServiceError(500, `save failed: ${String(err)}`);
      }
      return { version: await contentVersion(text) };
    });
  }

  /** The e-book (spec §7.8), built from the current files. */
  async exportEpub(book: string, edition: string | null): Promise<EpubBytes> {
    checkNames(book, edition);
    await this.chains.get(metadataKey(book, edition)); // a save under way lands
    return epubBytes(this.store, book, {
      edition,
      baseCss: this.buildOpts.baseCss,
    });
  }

  async createEdition(
    book: string,
    slug: string,
    from: string | null,
  ): Promise<void> {
    checkNames(book, null);
    if (!safeName(slug) || slug === "default") throw bad("bad edition slug");
    if (from !== null && !safeName(from)) throw bad("bad source edition");
    await this.requireBook(book);
    await this.chains.get(metadataKey(book, from)); // a save under way lands first
    const source = await this.readMetadata(book, from);
    if (!await createEdition(this.store, book, slug, source.metadata)) {
      throw new ServiceError(409, "edition already exists");
    }
  }

  async renameEdition(
    book: string,
    edition: string,
    target: string,
  ): Promise<void> {
    checkNames(book, edition);
    if (!safeName(target) || target === "default") {
      throw bad("bad edition slug");
    }
    const to = metadataKey(book, target);
    if (await this.store.exists(to)) {
      throw new ServiceError(409, "edition already exists");
    }
    // In the file's queue: a save already under way lands, then moves, so
    // the edit keeps under the new name.
    const from = metadataKey(book, edition);
    const moved = await this.serialize(from, () => this.store.rename(from, to));
    if (!moved) throw notFound("edition not found");
    // EXPERIMENTAL (§3.2.9): the edition's {only} token follows its slug.
    // Later saves carrying the old token are rewritten as they arrive.
    const stale = new Set(
      [...this.clients].filter((c) => c.book === book).map((c) => c.clientId),
    );
    if (stale.size) {
      this.tokenRenames.set(book, [
        ...this.tokenRenames.get(book) ?? [],
        { from: edition, to: target, stale },
      ]);
    }
    // In the book's queue, so no save lands between the read and the write.
    // Rewritten text has a new version, so every editor reloads it.
    const manuscript = `${book}/manuscript.md`;
    try {
      await this.serialize(book, async () => {
        const text = await this.store.readText(manuscript);
        if (text === null) return;
        const next = renameOnlyToken(text, edition, target);
        if (next !== text) {
          await this.store.write(manuscript, next);
        }
      });
    } catch (err) {
      throw new ServiceError(500, `token rewrite failed: ${String(err)}`);
    }
  }

  // The default edition has no slug to rename, only a display name, kept as
  // metadata.json's `name` and written as a metadata save.
  async renameDefault(book: string, name: string): Promise<void> {
    // Blank clears it, so the edition falls back to "Standard".
    await this.saveMetadata(book, null, { name: name.trim() || null });
  }

  async deleteEdition(book: string, edition: string): Promise<void> {
    checkNames(book, edition);
    const path = metadataKey(book, edition);
    const removed = await this.serialize(path, () => this.store.remove(path));
    if (!removed) throw notFound("edition not found");
  }

  // ---- subscriptions ----------------------------------------------------

  /** Sends the current build now and every rebuild after; returns unsubscribe. */
  subscribe(
    book: string,
    edition: string | null,
    clientId: string,
    send: (m: ServerMessage) => void,
  ): () => void {
    checkNames(book, edition);
    const client: Client = { send, book, edition, clientId };
    this.clients.add(client);
    this.buildMessage(book, edition).then((m) => {
      if (this.clients.has(client)) send(m);
    });
    return () => {
      this.clients.delete(client);
      for (const r of this.tokenRenames.get(book) ?? []) {
        r.stale.delete(clientId);
      }
      this.pruneRenames(book);
    };
  }

  // ---- internals --------------------------------------------------------

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  private pruneRenames(book: string) {
    const left = (this.tokenRenames.get(book) ?? []).filter((r) =>
      r.stale.size
    );
    if (left.length) this.tokenRenames.set(book, left);
    else this.tokenRenames.delete(book);
  }

  private async requireBook(book: string): Promise<void> {
    if (!await this.store.exists(`${book}/manuscript.md`)) {
      throw notFound("book not found");
    }
  }

  // The edition's stored metadata, and the text it was read from (null when
  // there is no metadata.json). Throws 409 when the file exists but is
  // corrupt JSON and 404 when a *named* edition's file is missing; a missing
  // metadata.json is {} because metadata is optional (spec §4).
  private async readMetadata(
    book: string,
    edition: string | null,
  ): Promise<{ metadata: Record<string, unknown>; text: string | null }> {
    const text = await this.store.readText(metadataKey(book, edition));
    if (text === null) {
      if (edition === null) return { metadata: {}, text: null };
      throw notFound("edition not found");
    }
    try {
      // Upgraded on the way out, so the panel edits (and then saves back) the
      // current shape — that is what retires a legacy `print` section on disk.
      const { meta } = parseMetadataText(text, metadataKey(book, edition));
      return { metadata: meta as Record<string, unknown>, text };
    } catch {
      throw new ServiceError(
        409,
        "metadata is not a valid JSON object — fix it on disk first",
      );
    }
  }

  private onChanged(paths: string[]) {
    // book → set of affected editions; undefined marks "shared: everyone".
    const changed = new Map<string, Set<string | null | undefined>>();
    const notImages = new Set<string>(); // books with a change outside images/
    for (const p of paths) {
      const [book, ...rest] = p.split("/");
      const change = book ? classifyChange(rest) : null;
      if (!book || !change) continue;
      let set = changed.get(book);
      if (!set) changed.set(book, set = new Set());
      set.add(change.kind === "shared" ? undefined : change.edition);
      if (rest[0] !== "images") notImages.add(book);
    }
    for (const [book, editions] of changed) {
      // An image dropped on the editor is followed by the manuscript save
      // naming it: hold an images-only rebuild a moment so the two paginate
      // once. Whatever comes next for the book takes the held one with it.
      const held = this.heldImages.get(book);
      clearTimeout(held);
      this.heldImages.delete(book);
      if (!notImages.has(book)) {
        this.heldImages.set(
          book,
          setTimeout(() => {
            this.heldImages.delete(book);
            this.broadcast(book, undefined);
          }, IMAGE_HOLD_MS),
        );
        continue;
      }
      if (held !== undefined) editions.add(undefined);
      if (editions.has(undefined)) this.broadcast(book, undefined);
      else for (const e of editions) this.broadcast(book, e);
    }
  }

  private async buildMessage(
    book: string,
    edition: string | null,
  ): Promise<ServerMessage> {
    try {
      return { type: "update", ...await this.build(book, edition) };
    } catch (err) {
      // Bad metadata or a mid-write read must never kill the server —
      // push the failure to the preview instead (Global Constraints).
      return { type: "error", book, edition, message: String(err) };
    }
  }

  // edition === undefined: a shared file changed — every client on the book,
  // each rebuilt for its own edition. Otherwise only that edition's clients.
  private async broadcast(book: string, edition: string | null | undefined) {
    const targets = [...this.clients].filter((c) =>
      c.book === book && (edition === undefined || c.edition === edition)
    );
    const messages = new Map<string | null, ServerMessage>(); // one build per edition
    for (const c of targets) {
      if (!messages.has(c.edition)) {
        messages.set(c.edition, await this.buildMessage(book, c.edition));
      }
    }
    for (const c of targets) {
      if (this.clients.has(c)) c.send(messages.get(c.edition)!);
    }
  }
}

// Longer than the editor's save debounce (600ms in app.ts) plus the watcher's.
const IMAGE_HOLD_MS = 1200;

function checkNames(book: string, edition: string | null): void {
  if (!safeName(book) || (edition !== null && !safeName(edition))) {
    throw bad("bad path");
  }
}

// Shallow-merge only the POSTed top-level keys; everything else —
// elements, is, future schema keys — passes through untouched.
export function mergeSections(
  base: Record<string, unknown>,
  sections: object,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(sections)) {
    if (value === null) delete merged[key]; // null removes a section outright
    else merged[key] = value;
  }
  return merged;
}
const serializeMeta = (m: object) => JSON.stringify(m, null, 2) + "\n";

/** A new book's metadata.json text: the template with a theme applied (spec
 * §4.13); no theme or House is the template as it is. Throws on an unknown
 * theme. Every front door (bml, the dev server, the in-page backend) runs it
 * before handing the text to createBook / importBook. */
export function themedTemplate(template: string, theme?: string): string {
  if (!theme || theme === "house") return template;
  return serializeMeta(applyTheme(JSON.parse(template) as Metadata, theme));
}
