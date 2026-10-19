// server/dev-server.ts — live dev server (spec §5.4, §6): serves the app shell,
// watches books, rebuilds on change, pushes updates over WebSockets, accepts saves.
import { buildBook, listBooks } from "./pipeline.ts";
import { watchTree } from "./watch.ts";
import { upgradePageSetup } from "../metadata/upgrade.ts";
import type { Metadata } from "../metadata/types.ts";
import {
  classifyChange,
  createEdition,
  listEditions,
  metadataPath,
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
};

export interface ServerOptions {
  booksRoot?: string; // default "books"
  port?: number; // 0 = OS-assigned (tests); default 8000
  saveDebounceMs?: number; // default 250 (used from Task 5)
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

interface PendingSave {
  text: string;
  clientId: string | null;
  timer: number;
}

export async function startServer(
  opts: ServerOptions = {},
): Promise<RunningServer> {
  const booksRoot = opts.booksRoot ?? "books";
  await Deno.stat(booksRoot); // fail fast at startup if the root is missing

  // watchFs reports resolved absolute paths (on macOS /var/… is realpathed to
  // /private/var/…), so map events back to book names via the root's realpath.
  const absRoot = await Deno.realPath(booksRoot);

  const clients = new Set<Client>();
  // book → clientId of the latest server-side write, so the originating editor
  // can ignore its own echo (spec §6). Written by the save endpoint (Task 5).
  const recentWrites = new Map<string, string | null>();

  const saveDebounceMs = opts.saveDebounceMs ?? 250;
  const pendingSaves = new Map<string, PendingSave>();

  async function handleSave(book: string, req: Request): Promise<Response> {
    if (!safeName(book)) return new Response("bad path", { status: 400 });
    let body: { text?: unknown; clientId?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }
    if (typeof body.text !== "string") {
      return new Response("body must be { text: string, clientId?: string }", {
        status: 400,
      });
    }
    try {
      await Deno.stat(`${booksRoot}/${book}/manuscript.md`);
    } catch {
      return new Response("book not found", { status: 404 });
    }
    const clientId = typeof body.clientId === "string" ? body.clientId : null;
    const existing = pendingSaves.get(book);
    if (existing) clearTimeout(existing.timer);
    const pending: PendingSave = { text: body.text, clientId, timer: 0 };
    pending.timer = setTimeout(async () => {
      pendingSaves.delete(book);
      recentWrites.set(book, pending.clientId);
      try {
        await Deno.writeTextFile(
          `${booksRoot}/${book}/manuscript.md`,
          pending.text,
        );
        // The watcher sees this write and broadcasts, tagged via recentWrites.
      } catch (err) {
        // No write means no filesystem event, so nothing will ever consume
        // (and clear) the recentWrites entry above — drop it ourselves so it
        // doesn't get misattributed to a later, unrelated broadcast for this
        // book. There's no open HTTP response left to report this on (the
        // {ok:true} response already went out), and per Global Constraints
        // the server must never die on bad state, so just log it.
        recentWrites.delete(book);
        console.error(`save failed for book "${book}":`, err);
      }
    }, saveDebounceMs);
    pendingSaves.set(book, pending);
    return Response.json({ ok: true });
  }

  async function handleManuscriptGet(book: string): Promise<Response> {
    if (!safeName(book)) return new Response("bad path", { status: 400 });
    // A save may still be sitting in the debounce window — serve what the
    // client most recently sent, not the stale disk copy.
    const pending = pendingSaves.get(book);
    if (pending) return Response.json({ text: pending.text });
    try {
      const text = await Deno.readTextFile(
        `${booksRoot}/${book}/manuscript.md`,
      );
      return Response.json({ text });
    } catch {
      return new Response("book not found", { status: 404 });
    }
  }

  interface PendingMetaSave {
    metadata: Record<string, unknown>;
    clientId: string | null;
    timer: number;
    cancelled?: boolean;
  }
  const pendingMetaSaves = new Map<string, PendingMetaSave>();

  // Metadata state is per edition; the manuscript's is per book.
  const metaKey = (book: string, edition: string | null) =>
    edition === null ? book : `${book}/editions/${edition}`;

  // The authoritative current metadata for serving and merging: a pending
  // debounced save wins over the disk copy. Returns null when the file exists
  // but is corrupt JSON — callers turn that into a 409. Returns undefined
  // when a *named* edition's file is missing (404); a missing metadata.json
  // is {} because metadata is optional (spec §4).
  async function currentMetadata(
    book: string,
    edition: string | null,
  ): Promise<Record<string, unknown> | null | undefined> {
    const pending = pendingMetaSaves.get(metaKey(book, edition));
    if (pending) return pending.metadata;
    let text: string;
    try {
      text = await Deno.readTextFile(metadataPath(booksRoot, book, edition));
    } catch {
      return edition === null ? {} : undefined;
    }
    try {
      // Upgraded on the way out, so the panel edits (and then saves back) the
      // current shape — that is what retires a legacy `print` section on disk.
      return upgradePageSetup(JSON.parse(text) as Metadata) as Record<
        string,
        unknown
      >;
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
    const metadata = await currentMetadata(book, edition);
    if (metadata === undefined) {
      return new Response("edition not found", { status: 404 });
    }
    if (metadata === null) {
      return new Response(
        "metadata is not valid JSON — fix it on disk first",
        { status: 409 },
      );
    }
    return Response.json({ metadata });
  }

  async function handleMetadataSave(
    book: string,
    edition: string | null,
    req: Request,
  ): Promise<Response> {
    if (!safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("bad path", { status: 400 });
    }
    let body: { sections?: unknown; clientId?: unknown };
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
        "body must be { sections: object, clientId?: string }",
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
    // Shallow-merge only the POSTed top-level keys; everything else —
    // elements, is, future schema keys — passes through untouched.
    const merged = { ...base };
    for (const [key, value] of Object.entries(sections)) {
      if (value === null) delete merged[key]; // null removes a section outright
      else merged[key] = value;
    }
    const key = metaKey(book, edition);
    const existing = pendingMetaSaves.get(key);
    if (existing) clearTimeout(existing.timer);
    const clientId = typeof body.clientId === "string" ? body.clientId : null;
    const save: PendingMetaSave = { metadata: merged, clientId, timer: 0 };
    save.timer = setTimeout(async () => {
      if (save.cancelled) return;
      pendingMetaSaves.delete(key);
      recentWrites.set(key, save.clientId);
      try {
        await Deno.writeTextFile(
          metadataPath(booksRoot, book, edition),
          JSON.stringify(save.metadata, null, 2) + "\n",
        );
        // The watcher sees this write and broadcasts, tagged via recentWrites.
      } catch (err) {
        recentWrites.delete(key);
        console.error(`metadata save failed for "${key}":`, err);
      }
    }, saveDebounceMs);
    pendingMetaSaves.set(key, save);
    return Response.json({ ok: true });
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
    if (typeof slug !== "string" || !safeName(slug)) {
      return new Response("bad edition slug", { status: 400 });
    }
    const from = typeof body.from === "string" ? body.from : null;
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
      await createEdition(booksRoot, book, slug, source);
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
    if (typeof target !== "string" || !safeName(target)) {
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
      // Cancel first: a flush already in flight (past its own cancelled
      // check, awaiting the write) must not resurrect the file after rename.
      pending.cancelled = true;
      clearTimeout(pending.timer); // any unflushed edit dies with the old name
      pendingMetaSaves.delete(metaKey(book, edition));
    }
    try {
      await Deno.rename(metadataPath(booksRoot, book, edition), to);
    } catch {
      return new Response("edition not found", { status: 404 });
    }
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
    try {
      await Deno.remove(metadataPath(booksRoot, book, edition));
    } catch {
      return new Response("edition not found", { status: 404 });
    }
    return Response.json({ ok: true });
  }

  async function buildMessage(
    book: string,
    edition: string | null,
    origin: string | null,
  ): Promise<string> {
    try {
      const build = await buildBook(booksRoot, book, { edition });
      return JSON.stringify({ type: "update", origin, ...build });
    } catch (err) {
      // Bad metadata or a mid-write read must never kill the server —
      // push the failure to the preview instead (Global Constraints).
      return JSON.stringify({
        type: "error",
        book,
        edition,
        origin,
        message: String(err),
      });
    }
  }

  // edition === undefined: a shared file changed — every client on the book,
  // each rebuilt for its own edition. Otherwise only that edition's clients.
  async function broadcast(book: string, edition: string | null | undefined) {
    const targets = [...clients].filter((c) =>
      c.book === book && c.socket.readyState === WebSocket.OPEN &&
      (edition === undefined || c.edition === edition)
    );
    const messages = new Map<string | null, string>(); // one build per edition
    if (edition !== undefined) {
      // Targeted: one edition, one origin key.
      const key = metaKey(book, edition);
      const origin = recentWrites.get(key) ?? null;
      recentWrites.delete(key);
      for (const c of targets) {
        let m = messages.get(c.edition);
        if (!m) {
          messages.set(
            c.edition,
            m = await buildMessage(book, c.edition, origin),
          );
        }
        c.socket.send(m);
      }
      return;
    }
    // Shared: a build (and origin) per distinct edition among the targets,
    // since a batched shared change may coincide with an edition's own flush.
    // The shared-file origin (keyed by `book`) applies to every edition, so
    // it's read once up front rather than deleted after the first edition
    // consumes it — otherwise later editions in the same batch would miss it.
    const sharedOrigin = recentWrites.get(book) ?? null;
    recentWrites.delete(book);
    for (const c of targets) {
      if (messages.has(c.edition)) continue;
      const key = metaKey(book, c.edition);
      const origin = sharedOrigin ?? recentWrites.get(key) ?? null;
      recentWrites.delete(key);
      messages.set(c.edition, await buildMessage(book, c.edition, origin));
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
      const message = await buildMessage(book, edition, null);
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    };
    socket.onclose = () => clients.delete(client);
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
      return handleEditionRename(editionRename[1]!, editionRename[2]!, req);
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
      for (const p of pendingSaves.values()) clearTimeout(p.timer);
      for (const p of pendingMetaSaves.values()) clearTimeout(p.timer);
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
  const running = await startServer({ port: Number(Deno.args[0] ?? "8000") });
  console.log(`book editor dev server → http://localhost:${running.port}/`);
}
