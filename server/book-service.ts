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
  NotFoundError,
  type ServerMessage,
} from "./pipeline.ts";
import { upgradeMetadata } from "../metadata/upgrade.ts";
import type { Metadata } from "../metadata/types.ts";
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
  saveDebounceMs?: number; // metadata saves; default 250
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

interface PendingMetaSave {
  metadata: Record<string, unknown>;
  text: string; // metadata serialized: what the write lands, unless...
  sections: object; // every section POSTed in this window, merged
  diskText: string | null; // ...the file moved on from this, its base
  timer: number;
  cancelled?: boolean;
  write(): Promise<void>; // the debounced write; also run early by an export
}

export class BookService {
  readonly store: BookStore;
  private readonly saveDebounceMs: number;
  private readonly buildOpts: Pick<BuildOptions, "baseCss" | "imageUrl">;
  private readonly clients = new Set<Client>();
  // key → the tail of its work queue. Keys are a book (its manuscript: a
  // save's check + write, a rename's token rewrite) or a metadata path (its
  // writes); safeName keeps the two apart, a path always has a "/".
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pendingMetaSaves = new Map<string, PendingMetaSave>();
  // EXPERIMENTAL (§3.2.9): book → edition renames whose {only} token a stale
  // save may still carry (another tab, a debounced save not yet sent). Each
  // lasts until every client connected at the rename has sent a save without
  // the old token or disconnected.
  private readonly tokenRenames = new Map<
    string,
    { from: string; to: string; stale: Set<string> }[]
  >();
  private readonly stopWatch: (() => void) | undefined;

  constructor(opts: ServiceOptions) {
    this.store = opts.store;
    this.saveDebounceMs = opts.saveDebounceMs ?? 250;
    this.buildOpts = { baseCss: opts.baseCss, imageUrl: opts.imageUrl };
    // A store with other writers (a folder on disk) reports their changes;
    // the service's own writes are reported by itself when it has none.
    this.stopWatch = this.store.watch?.((paths) => this.onChanged(paths));
  }

  async stop(): Promise<void> {
    this.stopWatch?.();
    for (const p of this.pendingMetaSaves.values()) clearTimeout(p.timer);
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

  /** Throws ServiceError 404 when the book or edition is missing. */
  async build(book: string, edition: string | null): Promise<BuildResult> {
    checkNames(book, edition);
    try {
      return await buildBook(this.store, book, { edition, ...this.buildOpts });
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
    if (!safeName(book) || !safeName(file)) throw bad("bad path");
    return this.store.read(`${book}/images/${file}`);
  }

  async metadata(
    book: string,
    edition: string | null,
  ): Promise<MetadataResult> {
    checkNames(book, edition);
    await this.requireBook(book);
    const current = await this.currentMetadata(book, edition);
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
    this.notify([manuscript, metadataKey(book, null)]);
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
      await this.store.write(`${book}/${path}`, data);
    }
    this.notify([manuscript, meta]);
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
      this.notify([path]);
      const version = await contentVersion(text);
      return text === save.text
        ? { ok: true, version }
        : { ok: true, version, text };
    });
  }

  /** Shallow-merges the sections into the edition's metadata (debounced). */
  async saveMetadata(
    book: string,
    edition: string | null,
    sections: object,
  ): Promise<{ version: string }> {
    checkNames(book, edition);
    await this.requireBook(book);
    const base = await this.currentMetadata(book, edition);
    const save = this.queueMetaSave(book, edition, base, sections);
    return { version: await contentVersion(save.text) };
  }

  /** The e-book (spec §7.8), built from the current files. */
  async exportEpub(book: string, edition: string | null): Promise<EpubBytes> {
    checkNames(book, edition);
    await this.flushMetadata(book, edition);
    return epubBytes(this.store, book, {
      edition,
      baseCss: this.buildOpts.baseCss,
    });
  }

  /** Lands a debounced metadata save now (an export reads the file). */
  async flushMetadata(book: string, edition: string | null): Promise<void> {
    await this.pendingMetaSaves.get(metaKey(book, edition))?.write();
    await this.chains.get(metadataKey(book, edition));
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
    const source = await this.currentMetadata(book, from);
    if (!await createEdition(this.store, book, slug, source.metadata)) {
      throw new ServiceError(409, "edition already exists");
    }
    this.notify([metadataKey(book, slug)]);
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
    const pending = this.pendingMetaSaves.get(metaKey(book, edition));
    if (pending) {
      pending.cancelled = true;
      clearTimeout(pending.timer); // any unflushed edit dies with the old name
      this.pendingMetaSaves.delete(metaKey(book, edition));
    }
    // In the file's queue: a write already under way lands, then moves.
    const from = metadataKey(book, edition);
    const moved = await this.serialize(from, () => this.store.rename(from, to));
    if (!moved) throw notFound("edition not found");
    this.notify([from, to]);
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
          this.notify([manuscript]);
        }
      });
    } catch (err) {
      throw new ServiceError(500, `token rewrite failed: ${String(err)}`);
    }
  }

  // The default edition has no slug to rename, only a display name, kept as
  // metadata.json's `name` and written through the pending-save path.
  async renameDefault(book: string, name: string): Promise<void> {
    checkNames(book, null);
    await this.requireBook(book);
    const base = await this.currentMetadata(book, null);
    // Blank clears it, so the edition falls back to "Standard".
    const trimmed = name.trim();
    await this.queueMetaSave(book, null, base, { name: trimmed || null })
      .write();
  }

  async deleteEdition(book: string, edition: string): Promise<void> {
    checkNames(book, edition);
    const pending = this.pendingMetaSaves.get(metaKey(book, edition));
    if (pending) {
      pending.cancelled = true;
      clearTimeout(pending.timer);
      this.pendingMetaSaves.delete(metaKey(book, edition));
    }
    const path = metadataKey(book, edition);
    const removed = await this.serialize(path, () => this.store.remove(path));
    if (!removed) throw notFound("edition not found");
    this.notify([path]);
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

  // The authoritative current metadata for serving and merging: a pending
  // debounced save wins over the stored copy. `text` is what it was read from
  // (the pending save's serialization or the raw file; null when there is no
  // metadata.json). Throws 409 when the file exists but is corrupt JSON and
  // 404 when a *named* edition's file is missing; a missing metadata.json is
  // {} because metadata is optional (spec §4).
  private currentMetadata(
    book: string,
    edition: string | null,
  ): Promise<{ metadata: Record<string, unknown>; text: string | null }> {
    const pending = this.pendingMetaSaves.get(metaKey(book, edition));
    if (pending) {
      return Promise.resolve({
        metadata: pending.metadata,
        text: pending.text,
      });
    }
    return this.readMetadata(book, edition);
  }

  // currentMetadata's stored half, same results.
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
      const metadata = upgradeMetadata(JSON.parse(text) as Metadata);
      return { metadata: metadata as Record<string, unknown>, text };
    } catch {
      throw new ServiceError(
        409,
        "metadata is not valid JSON — fix it on disk first",
      );
    }
  }

  // Debounces a metadata write: `sections` shallow-merged onto `base` (the
  // edition's currentMetadata), replacing any save already pending for it.
  private queueMetaSave(
    book: string,
    edition: string | null,
    base: { metadata: Record<string, unknown>; text: string | null },
    sections: object,
  ): PendingMetaSave {
    const merged = mergeSections(base.metadata, sections);
    const key = metaKey(book, edition);
    const path = metadataKey(book, edition);
    const existing = this.pendingMetaSaves.get(key);
    if (existing) clearTimeout(existing.timer);
    const save: PendingMetaSave = {
      metadata: merged,
      text: serializeMeta(merged),
      sections: { ...existing?.sections, ...sections },
      diskText: existing ? existing.diskText : base.text,
      timer: 0,
      write: () => {
        clearTimeout(save.timer);
        if (this.pendingMetaSaves.get(key) !== save) {
          return this.chains.get(path) ?? Promise.resolve(); // already under way
        }
        this.pendingMetaSaves.delete(key);
        // One write per file at a time; a rename or delete waits its turn.
        return this.serialize(path, async () => {
          if (save.cancelled) return;
          try {
            // The file changed during the window (another writer, or the
            // previous write): merge this window's sections onto it instead,
            // so another section's edit survives.
            let text = save.text;
            const disk = await this.readMetadata(book, edition);
            if (disk.text !== save.diskText) {
              text = serializeMeta(mergeSections(disk.metadata, save.sections));
            }
            await this.store.write(path, text);
            this.notify([path]);
          } catch (err) {
            // A debounced write fails after its {ok} went out, so there is
            // no response left to report on: tell the edition's editors.
            this.sendMetaError(book, edition, `save failed: ${String(err)}`);
          }
        });
      },
    };
    save.timer = setTimeout(save.write, this.saveDebounceMs);
    this.pendingMetaSaves.set(key, save);
    return save;
  }

  private sendMetaError(
    book: string,
    edition: string | null,
    message: string,
  ) {
    console.error(`${book}: ${message}`);
    for (const c of this.clients) {
      if (c.book !== book || c.edition !== edition) continue;
      c.send({ type: "error", book, edition, message, save: "metadata" });
    }
  }

  // The service's own writes, for a store that can't see them happen.
  private notify(paths: string[]) {
    if (!this.store.watch) this.onChanged(paths);
  }

  private onChanged(paths: string[]) {
    // book → set of affected editions; undefined marks "shared: everyone".
    const changed = new Map<string, Set<string | null | undefined>>();
    for (const p of paths) {
      const [book, ...rest] = p.split("/");
      const change = book ? classifyChange(rest) : null;
      if (!book || !change) continue;
      let set = changed.get(book);
      if (!set) changed.set(book, set = new Set());
      set.add(change.kind === "shared" ? undefined : change.edition);
    }
    for (const [book, editions] of changed) {
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

// Metadata state is per edition; the manuscript's is per book.
const metaKey = (book: string, edition: string | null) =>
  edition === null ? book : `${book}/editions/${edition}`;

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
