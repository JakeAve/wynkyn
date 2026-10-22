// server/dev-server.ts — live dev server (spec §5.4, §6): serves the app shell,
// watches books, rebuilds on change, pushes updates over WebSockets, accepts saves.
import {
  buildBook,
  contentVersion,
  listBooks,
  type ServerMessage,
} from "./pipeline.ts";
import { watchTree } from "./watch.ts";
import { defaultPort } from "./port.ts";
import { upgradePageSetup } from "../metadata/upgrade.ts";
import type { Metadata } from "../metadata/types.ts";
import {
  exportBook,
  type ExportOptions,
  formatSummary,
  PaginationError,
} from "./print-export.ts";
import { exportEpub } from "./epub-export.ts";
import { installedFonts } from "./local-fonts.ts";
import { formatProblem } from "../renderer/page-map-types.ts";
import {
  classifyChange,
  createEdition,
  listEditions,
  metadataPath,
  renameOnlyToken,
  safeName,
} from "./editions.ts";

const WEB_DIR = new URL("../web/", import.meta.url);
const PAGED_DIR = new URL("../vendor/pagedjs/", import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
};

export interface ServerOptions {
  booksRoot?: string; // default "books"
  port?: number; // 0 = OS-assigned (tests); default 8000
  saveDebounceMs?: number; // metadata saves; default 250
  render?: ExportOptions["render"]; // test seam: print export without Chrome
}

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

interface Client {
  socket: WebSocket;
  book: string;
  edition: string | null;
  clientId: string;
}

// Readers see the old file or the new one, never half a write; the watcher
// ignores the .tmp name (classifyChange). The tmp name is unique, so two
// writes to one path never share (and rename away) each other's tmp file.
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

export async function startServer(
  opts: ServerOptions = {},
): Promise<RunningServer> {
  const booksRoot = opts.booksRoot ?? "books";
  try {
    await Deno.stat(booksRoot); // fail fast at startup if the root is missing
  } catch {
    throw new Error(
      `${booksRoot}/ not found — in a worktree, \`deno task setup\` links it to the main checkout's library`,
    );
  }

  // watchFs reports resolved absolute paths (on macOS /var/… is realpathed to
  // /private/var/…), so map events back to book names via the root's realpath.
  const absRoot = await Deno.realPath(booksRoot);

  const clients = new Set<Client>();

  const saveDebounceMs = opts.saveDebounceMs ?? 250; // metadata only
  // key → the tail of its work queue. Keys are a book (its manuscript: a
  // save's check + write, a rename's token rewrite) or a metadata path (its
  // writes); safeName keeps the two apart, a path always has a "/".
  const chains = new Map<string, Promise<void>>();
  function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }
  // EXPERIMENTAL (§3.2.9): book → edition renames whose {only} token a stale
  // save may still carry (another tab, a debounced save not yet sent). Each
  // lasts until every client connected at the rename has sent a save without
  // the old token or disconnected.
  const tokenRenames = new Map<
    string,
    { from: string; to: string; stale: Set<string> }[]
  >();
  const pruneRenames = (book: string) => {
    const left = (tokenRenames.get(book) ?? []).filter((r) => r.stale.size);
    if (left.length) tokenRenames.set(book, left);
    else tokenRenames.delete(book);
  };

  // A debounced metadata write fails after its {ok:true} went out, so there
  // is no response left to report on: tell the edition's editors instead,
  // and never let it kill the server.
  function sendMetaError(
    book: string,
    edition: string | null,
    message: string,
  ) {
    console.error(`${book}: ${message}`);
    for (const c of clients) {
      if (c.book !== book || c.socket.readyState !== WebSocket.OPEN) continue;
      if (c.edition !== edition) continue;
      const m: ServerMessage = {
        type: "error",
        book,
        edition,
        message,
        save: "metadata",
      };
      c.socket.send(JSON.stringify(m));
    }
  }

  // The client debounces and sends one save at a time, so a save lands before
  // it is answered: the check against `base` and the write run in the book's
  // queue, never interleaved with another save or a rename's rewrite.
  async function handleSave(book: string, req: Request): Promise<Response> {
    if (!safeName(book)) return new Response("bad path", { status: 400 });
    let body: { text?: unknown; clientId?: unknown; base?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    const sent = body.text;
    if (typeof sent !== "string") {
      return new Response(
        "body must be { text: string, clientId?: string, base?: string }",
        { status: 400 },
      );
    }
    const clientId = typeof body.clientId === "string" ? body.clientId : null;
    const path = `${booksRoot}/${book}/manuscript.md`;
    try {
      return await serialize(book, async () => {
        const current = await Deno.readTextFile(path);
        // A save based on a version that is no longer current would overwrite
        // a change its editor never saw: refuse it with the current text. No
        // base (the CLI, old callers) skips the check.
        if (typeof body.base === "string") {
          const version = await contentVersion(current);
          if (version !== body.base) {
            return Response.json({ conflict: true, text: current, version }, {
              status: 409,
            });
          }
        }
        // A save still carrying a renamed edition's old token gets the new
        // one, and the response hands the rewritten text back.
        let text = sent;
        for (const r of tokenRenames.get(book) ?? []) {
          if (clientId !== null && !r.stale.has(clientId)) continue;
          const next = renameOnlyToken(text, r.from, r.to);
          if (next !== text) text = next;
          else if (clientId !== null) r.stale.delete(clientId); // caught up
        }
        pruneRenames(book);
        await atomicWrite(path, text); // the watcher sees it and broadcasts
        const version = await contentVersion(text);
        return Response.json(
          text === sent ? { ok: true, version } : { ok: true, version, text },
        );
      });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return new Response("book not found", { status: 404 });
      }
      return new Response(`save failed: ${String(err)}`, { status: 500 });
    }
  }

  async function handleManuscriptGet(book: string): Promise<Response> {
    if (!safeName(book)) return new Response("bad path", { status: 400 });
    await chains.get(book); // a save under way lands first
    let text: string;
    try {
      text = await Deno.readTextFile(`${booksRoot}/${book}/manuscript.md`);
    } catch {
      return new Response("book not found", { status: 404 });
    }
    return Response.json({ text, version: await contentVersion(text) });
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
  const pendingMetaSaves = new Map<string, PendingMetaSave>();

  // Metadata state is per edition; the manuscript's is per book.
  const metaKey = (book: string, edition: string | null) =>
    edition === null ? book : `${book}/editions/${edition}`;

  // The authoritative current metadata for serving and merging: a pending
  // debounced save wins over the disk copy. `text` is what it was read from
  // (the pending save's serialization or the raw file; null when there is no
  // metadata.json). Returns null when the file exists but is corrupt JSON —
  // callers turn that into a 409. Returns undefined when a *named* edition's
  // file is missing (404); a missing metadata.json is {} because metadata is
  // optional (spec §4).
  function currentMetadata(
    book: string,
    edition: string | null,
  ): Promise<
    | { metadata: Record<string, unknown>; text: string | null }
    | null
    | undefined
  > {
    const pending = pendingMetaSaves.get(metaKey(book, edition));
    if (pending) {
      return Promise.resolve({
        metadata: pending.metadata,
        text: pending.text,
      });
    }
    return readMetadata(book, edition);
  }

  // currentMetadata's disk half, same results.
  async function readMetadata(
    book: string,
    edition: string | null,
  ): Promise<
    | { metadata: Record<string, unknown>; text: string | null }
    | null
    | undefined
  > {
    let text: string;
    try {
      text = await Deno.readTextFile(metadataPath(booksRoot, book, edition));
    } catch {
      return edition === null ? { metadata: {}, text: null } : undefined;
    }
    try {
      // Upgraded on the way out, so the panel edits (and then saves back) the
      // current shape — that is what retires a legacy `print` section on disk.
      const metadata = upgradePageSetup(JSON.parse(text) as Metadata);
      return { metadata: metadata as Record<string, unknown>, text };
    } catch {
      return null;
    }
  }

  async function handleMetadataGet(
    book: string,
    edition: string | null,
  ): Promise<Response> {
    if (!safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("bad path", { status: 400 });
    }
    try {
      await Deno.stat(`${booksRoot}/${book}/manuscript.md`);
    } catch {
      return new Response("book not found", { status: 404 });
    }
    const current = await currentMetadata(book, edition);
    if (current === undefined) {
      return new Response("edition not found", { status: 404 });
    }
    if (current === null) {
      return new Response(
        "metadata is not valid JSON — fix it on disk first",
        { status: 409 },
      );
    }
    return Response.json({
      metadata: current.metadata,
      version: current.text === null
        ? null
        : await contentVersion(current.text),
    });
  }

  async function handleMetadataSave(
    book: string,
    edition: string | null,
    req: Request,
  ): Promise<Response> {
    if (!safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("bad path", { status: 400 });
    }
    let body: { sections?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    const sections = body.sections;
    if (
      sections === null || typeof sections !== "object" ||
      Array.isArray(sections)
    ) {
      return new Response(
        "body must be { sections: object }",
        { status: 400 },
      );
    }
    try {
      await Deno.stat(`${booksRoot}/${book}/manuscript.md`);
    } catch {
      return new Response("book not found", { status: 404 });
    }
    const base = await currentMetadata(book, edition);
    if (base === undefined) {
      return new Response("edition not found", { status: 404 });
    }
    if (base === null) {
      return new Response(
        "metadata is not valid JSON — fix it on disk first",
        { status: 409 },
      );
    }
    const save = queueMetaSave(book, edition, base, sections);
    return Response.json({
      ok: true,
      version: await contentVersion(save.text),
    });
  }

  // Shallow-merge only the POSTed top-level keys; everything else —
  // elements, is, future schema keys — passes through untouched.
  function mergeSections(base: Record<string, unknown>, sections: object) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(sections)) {
      if (value === null) delete merged[key]; // null removes a section outright
      else merged[key] = value;
    }
    return merged;
  }
  const serializeMeta = (m: object) => JSON.stringify(m, null, 2) + "\n";

  // Debounces a metadata write: `sections` shallow-merged onto `base` (the
  // edition's currentMetadata), replacing any save already pending for it.
  function queueMetaSave(
    book: string,
    edition: string | null,
    base: { metadata: Record<string, unknown>; text: string | null },
    sections: object,
  ): PendingMetaSave {
    const merged = mergeSections(base.metadata, sections);
    const key = metaKey(book, edition);
    const path = metadataPath(booksRoot, book, edition);
    const existing = pendingMetaSaves.get(key);
    if (existing) clearTimeout(existing.timer);
    const save: PendingMetaSave = {
      metadata: merged,
      text: serializeMeta(merged),
      sections: { ...existing?.sections, ...sections },
      diskText: existing ? existing.diskText : base.text,
      timer: 0,
      write: () => {
        clearTimeout(save.timer);
        if (pendingMetaSaves.get(key) !== save) {
          return chains.get(path) ?? Promise.resolve(); // already under way
        }
        pendingMetaSaves.delete(key);
        // One write per file at a time; a rename or delete waits its turn.
        return serialize(path, async () => {
          if (save.cancelled) return;
          try {
            // The file changed during the window (another writer, or the
            // previous write): merge this window's sections onto it instead,
            // so another section's edit survives.
            let text = save.text;
            const disk = await readMetadata(book, edition);
            if (disk === undefined) throw new Error("edition not found");
            if (disk === null) throw new Error("metadata is not valid JSON");
            if (disk.text !== save.diskText) {
              text = serializeMeta(mergeSections(disk.metadata, save.sections));
            }
            await atomicWrite(path, text); // the watcher sees it and broadcasts
          } catch (err) {
            sendMetaError(book, edition, `save failed: ${String(err)}`);
          }
        });
      },
    };
    save.timer = setTimeout(save.write, saveDebounceMs);
    pendingMetaSaves.set(key, save);
    return save;
  }

  // book/edition keys with an export running; one at a time each.
  const exporting = new Set<string>();
  const exportDir = (book: string, edition: string | null) =>
    `${booksRoot}/${book}/export${edition === null ? "" : `/${edition}`}`;

  // The Publish tab's print export (spec §7.7): `bml export` behind an endpoint, so
  // both write the same files. The body is { proof?, force?, pages? }.
  async function handleExport(
    book: string,
    edition: string | null,
    req: Request,
  ): Promise<Response> {
    if (!safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("bad path", { status: 400 });
    }
    let body: { proof?: unknown; force?: unknown; pages?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    const key = metaKey(book, edition);
    if (exporting.has(key)) {
      return new Response("an export is already running", { status: 409 });
    }
    exporting.add(key);
    try {
      // The export reads metadata from disk: land a debounced save first.
      await pendingMetaSaves.get(key)?.write();
      await chains.get(metadataPath(booksRoot, book, edition));
      const s = await exportBook(booksRoot, book, {
        edition,
        proof: body.proof === true,
        force: body.force === true,
        pages: typeof body.pages === "number" ? body.pages : undefined,
        render: opts.render,
      });
      return Response.json({
        summary: formatSummary(book, s),
        files: s.files.map((f) => f.slice(f.lastIndexOf("/") + 1))
          .filter((f) => f.endsWith(".pdf")),
        problems: s.pagination.map(formatProblem),
      });
    } catch (err) {
      if (err instanceof PaginationError) {
        return Response.json(
          { problems: err.problems.map(formatProblem) },
          { status: 409 },
        );
      }
      return new Response((err as Error).message, { status: 500 });
    } finally {
      exporting.delete(key);
    }
  }

  // The Publish tab's e-book export (spec §7.8): `bml epub` behind an
  // endpoint. The file lands beside the print export, served by the same
  // GET /api/books/<book>/export/<file>.
  async function handleEpub(
    book: string,
    edition: string | null,
  ): Promise<Response> {
    if (!safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("bad path", { status: 400 });
    }
    const key = metaKey(book, edition);
    if (exporting.has(key)) {
      return new Response("an export is already running", { status: 409 });
    }
    exporting.add(key);
    try {
      await pendingMetaSaves.get(key)?.write();
      await chains.get(metadataPath(booksRoot, book, edition));
      const s = await exportEpub(booksRoot, book, { edition });
      return Response.json({
        file: s.file.slice(s.file.lastIndexOf("/") + 1),
        documents: s.documents,
      });
    } catch (err) {
      return new Response((err as Error).message, { status: 500 });
    } finally {
      exporting.delete(key);
    }
  }

  async function handleEditionCreate(
    book: string,
    req: Request,
  ): Promise<Response> {
    if (!safeName(book)) return new Response("bad path", { status: 400 });
    let body: { slug?: unknown; from?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    const slug = body.slug;
    if (typeof slug !== "string" || !safeName(slug) || slug === "default") {
      return new Response("bad edition slug", { status: 400 });
    }
    // "default" names the unnamed edition here, as in the rename route.
    const from = typeof body.from === "string" && body.from !== "default"
      ? body.from
      : null;
    if (from !== null && !safeName(from)) {
      return new Response("bad source edition", { status: 400 });
    }
    try {
      await Deno.stat(`${booksRoot}/${book}/manuscript.md`);
    } catch {
      return new Response("book not found", { status: 404 });
    }
    const source = await currentMetadata(book, from);
    if (source === undefined) {
      return new Response("edition not found", { status: 404 });
    }
    if (source === null) {
      return new Response("source metadata is not valid JSON", {
        status: 409,
      });
    }
    try {
      await createEdition(booksRoot, book, slug, source.metadata);
    } catch (err) {
      if (err instanceof Deno.errors.AlreadyExists) {
        return new Response("edition already exists", { status: 409 });
      }
      throw err;
    }
    return Response.json({ ok: true }, { status: 201 });
  }

  async function handleEditionRename(
    book: string,
    edition: string,
    req: Request,
  ): Promise<Response> {
    if (!safeName(book) || !safeName(edition)) {
      return new Response("bad path", { status: 400 });
    }
    let body: { slug?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    const target = body.slug;
    if (
      typeof target !== "string" || !safeName(target) || target === "default"
    ) {
      return new Response("bad edition slug", { status: 400 });
    }
    const to = metadataPath(booksRoot, book, target);
    try {
      await Deno.stat(to);
      return new Response("edition already exists", { status: 409 });
    } catch {
      // free
    }
    const pending = pendingMetaSaves.get(metaKey(book, edition));
    if (pending) {
      pending.cancelled = true;
      clearTimeout(pending.timer); // any unflushed edit dies with the old name
      pendingMetaSaves.delete(metaKey(book, edition));
    }
    // In the file's queue: a write already under way lands, then moves.
    const from = metadataPath(booksRoot, book, edition);
    try {
      await serialize(from, () => Deno.rename(from, to));
    } catch {
      return new Response("edition not found", { status: 404 });
    }
    // EXPERIMENTAL (§3.2.9): the edition's {only} token follows its slug.
    // Later saves carrying the old token are rewritten as they arrive.
    const stale = new Set(
      [...clients].filter((c) => c.book === book).map((c) => c.clientId),
    );
    if (stale.size) {
      tokenRenames.set(book, [
        ...tokenRenames.get(book) ?? [],
        { from: edition, to: target, stale },
      ]);
    }
    // In the book's queue, so no save lands between the read and the write.
    // Rewritten text has a new version, so every editor reloads it.
    const manuscript = `${booksRoot}/${book}/manuscript.md`;
    try {
      await serialize(book, async () => {
        const text = await Deno.readTextFile(manuscript);
        const next = renameOnlyToken(text, edition, target);
        if (next !== text) await atomicWrite(manuscript, next);
      });
    } catch (err) {
      return new Response(`token rewrite failed: ${String(err)}`, {
        status: 500,
      });
    }
    return Response.json({ ok: true });
  }

  // The default edition has no slug to rename, only a display name, kept as
  // metadata.json's `name` and written through the pending-save path.
  async function handleDefaultRename(
    book: string,
    req: Request,
  ): Promise<Response> {
    if (!safeName(book)) return new Response("bad path", { status: 400 });
    let body: { name?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    if (typeof body.name !== "string") {
      return new Response("body must be { name: string }", { status: 400 });
    }
    try {
      await Deno.stat(`${booksRoot}/${book}/manuscript.md`);
    } catch {
      return new Response("book not found", { status: 404 });
    }
    const base = await currentMetadata(book, null);
    if (!base) {
      return new Response(
        "metadata is not valid JSON — fix it on disk first",
        { status: 409 },
      );
    }
    const name = body.name.trim();
    // Blank clears it, so the edition falls back to "Standard".
    await queueMetaSave(book, null, base, { name: name || null }).write();
    return Response.json({ ok: true });
  }

  async function handleEditionDelete(
    book: string,
    edition: string,
  ): Promise<Response> {
    if (!safeName(book) || !safeName(edition)) {
      return new Response("bad path", { status: 400 });
    }
    const pending = pendingMetaSaves.get(metaKey(book, edition));
    if (pending) {
      pending.cancelled = true;
      clearTimeout(pending.timer);
      pendingMetaSaves.delete(metaKey(book, edition));
    }
    const path = metadataPath(booksRoot, book, edition);
    try {
      await serialize(path, () => Deno.remove(path));
    } catch {
      return new Response("edition not found", { status: 404 });
    }
    return Response.json({ ok: true });
  }

  async function buildMessage(
    book: string,
    edition: string | null,
  ): Promise<string> {
    let m: ServerMessage;
    try {
      m = { type: "update", ...await buildBook(booksRoot, book, { edition }) };
    } catch (err) {
      // Bad metadata or a mid-write read must never kill the server —
      // push the failure to the preview instead (Global Constraints).
      m = { type: "error", book, edition, message: String(err) };
    }
    return JSON.stringify(m);
  }

  // edition === undefined: a shared file changed — every client on the book,
  // each rebuilt for its own edition. Otherwise only that edition's clients.
  async function broadcast(book: string, edition: string | null | undefined) {
    const targets = [...clients].filter((c) =>
      c.book === book && c.socket.readyState === WebSocket.OPEN &&
      (edition === undefined || c.edition === edition)
    );
    const messages = new Map<string | null, string>(); // one build per edition
    for (const c of targets) {
      if (!messages.has(c.edition)) {
        messages.set(c.edition, await buildMessage(book, c.edition));
      }
    }
    for (const c of targets) c.socket.send(messages.get(c.edition)!);
  }

  const watcher = watchTree(booksRoot, (paths) => {
    // book → set of affected editions; undefined marks "shared: everyone".
    const changed = new Map<string, Set<string | null | undefined>>();
    for (const p of paths) {
      if (!p.startsWith(absRoot + "/")) continue;
      const [book, ...rest] = p.slice(absRoot.length + 1).split("/");
      const change = book ? classifyChange(rest) : null;
      if (!book || !change) continue;
      let set = changed.get(book);
      if (!set) changed.set(book, set = new Set());
      set.add(change.kind === "shared" ? undefined : change.edition);
    }
    for (const [book, editions] of changed) {
      if (editions.has(undefined)) broadcast(book, undefined);
      else for (const e of editions) broadcast(book, e);
    }
  });

  function handleWebSocket(req: Request, url: URL): Response {
    const book = url.searchParams.get("book");
    const edition = url.searchParams.get("edition");
    if (!book || !safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("missing or bad book/edition param", { status: 400 });
    }
    const clientId = url.searchParams.get("client") ?? crypto.randomUUID();
    const { socket, response } = Deno.upgradeWebSocket(req);
    const client: Client = { socket, book, edition, clientId };
    socket.onopen = async () => {
      clients.add(client);
      const message = await buildMessage(book, edition);
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    };
    socket.onclose = () => {
      clients.delete(client);
      for (const r of tokenRenames.get(book) ?? []) r.stale.delete(clientId);
      pruneRenames(book);
    };
    socket.onerror = () => clients.delete(client);
    return response;
  }

  async function serveStatic(
    dirUrl: URL | string,
    name: string,
  ): Promise<Response> {
    if (!safeName(name)) return new Response("bad path", { status: 400 });
    try {
      const data = typeof dirUrl === "string"
        ? await Deno.readFile(`${dirUrl}/${name}`)
        : await Deno.readFile(new URL(name, dirUrl));
      const ext = name.slice(name.lastIndexOf("."));
      return new Response(data, {
        headers: {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") return handleWebSocket(req, url);

    if (path === "/" || path === "/index.html") {
      return serveStatic(WEB_DIR, "index.html");
    }
    if (path === "/vendor/paged.js") return serveStatic(PAGED_DIR, "paged.js");
    if (path.startsWith("/web/")) {
      return serveStatic(WEB_DIR, path.slice("/web/".length));
    }

    if (path === "/api/books" && req.method === "GET") {
      return Response.json({ books: await listBooks(booksRoot) });
    }
    if (path === "/api/fonts" && req.method === "GET") {
      return Response.json({ installed: await installedFonts() });
    }

    const bookApi = path.match(/^\/api\/books\/([^/]+)$/);
    if (bookApi && req.method === "GET") {
      const book = bookApi[1]!;
      const edition = url.searchParams.get("edition");
      if (!safeName(book) || (edition !== null && !safeName(edition))) {
        return new Response("bad path", { status: 400 });
      }
      try {
        return Response.json(await buildBook(booksRoot, book, { edition }));
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return new Response("book or edition not found", { status: 404 });
        }
        return new Response(`build failed: ${String(err)}`, { status: 500 });
      }
    }

    const manuscriptApi = path.match(/^\/api\/books\/([^/]+)\/manuscript$/);
    if (manuscriptApi && req.method === "GET") {
      return handleManuscriptGet(manuscriptApi[1]!);
    }
    if (manuscriptApi && req.method === "POST") {
      return handleSave(manuscriptApi[1]!, req);
    }

    const metadataApi = path.match(/^\/api\/books\/([^/]+)\/metadata$/);
    if (metadataApi && req.method === "GET") {
      return handleMetadataGet(metadataApi[1]!, null);
    }
    if (metadataApi && req.method === "POST") {
      return handleMetadataSave(metadataApi[1]!, null, req);
    }

    const editionsApi = path.match(/^\/api\/books\/([^/]+)\/editions$/);
    if (editionsApi && req.method === "GET") {
      const book = editionsApi[1]!;
      if (!safeName(book)) return new Response("bad path", { status: 400 });
      try {
        await Deno.stat(`${booksRoot}/${book}/manuscript.md`);
      } catch {
        return new Response("book not found", { status: 404 });
      }
      return Response.json({ editions: await listEditions(booksRoot, book) });
    }
    if (editionsApi && req.method === "POST") {
      return handleEditionCreate(editionsApi[1]!, req);
    }

    const editionApi = path.match(/^\/api\/books\/([^/]+)\/editions\/([^/]+)$/);
    if (editionApi && req.method === "DELETE") {
      return handleEditionDelete(editionApi[1]!, editionApi[2]!);
    }

    const editionMeta = path.match(
      /^\/api\/books\/([^/]+)\/editions\/([^/]+)\/metadata$/,
    );
    if (editionMeta && !safeName(editionMeta[2]!)) {
      return new Response("bad path", { status: 400 });
    }
    if (editionMeta && req.method === "GET") {
      return handleMetadataGet(editionMeta[1]!, editionMeta[2]!);
    }
    if (editionMeta && req.method === "POST") {
      return handleMetadataSave(editionMeta[1]!, editionMeta[2]!, req);
    }

    const editionRename = path.match(
      /^\/api\/books\/([^/]+)\/editions\/([^/]+)\/rename$/,
    );
    if (editionRename && req.method === "POST") {
      if (editionRename[2] === "default") {
        return handleDefaultRename(editionRename[1]!, req);
      }
      return handleEditionRename(editionRename[1]!, editionRename[2]!, req);
    }

    const exportApi = path.match(
      /^\/api\/books\/([^/]+)\/export(?:\/([^/]+))?$/,
    );
    if (exportApi) {
      const [, book, file] = exportApi;
      const edition = url.searchParams.get("edition");
      if (!file && req.method === "POST") {
        return handleExport(book!, edition, req);
      }
      if (file && req.method === "GET") {
        if (!safeName(book!) || (edition !== null && !safeName(edition))) {
          return new Response("bad path", { status: 400 });
        }
        return serveStatic(exportDir(book!, edition), file);
      }
    }

    const epubApi = path.match(/^\/api\/books\/([^/]+)\/epub$/);
    if (epubApi && req.method === "POST") {
      return handleEpub(epubApi[1]!, url.searchParams.get("edition"));
    }

    const image = path.match(/^\/books\/([^/]+)\/images\/([^/]+)$/);
    if (image && req.method === "GET") {
      const [, book, file] = image;
      if (!safeName(book!) || !safeName(file!)) {
        return new Response("bad path", { status: 400 });
      }
      return serveStatic(`${booksRoot}/${book}/images`, file!);
    }

    return new Response("not found", { status: 404 });
  }

  const server = Deno.serve(
    { port: opts.port ?? 8000, onListen: () => {} },
    handleRequest,
  );

  return {
    port: server.addr.port,
    async stop() {
      watcher.stop();
      for (const p of pendingMetaSaves.values()) clearTimeout(p.timer);
      await Promise.all(chains.values()); // writes under way land
      for (const c of clients) {
        try {
          c.socket.close();
        } catch {
          // already closed
        }
      }
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  const running = await startServer({ port: defaultPort() });
  console.log(`wynkyn dev server → http://localhost:${running.port}/`);
}
