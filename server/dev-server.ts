// server/dev-server.ts — live dev server (spec §5.4, §6): serves the app shell,
// watches books, rebuilds on change, pushes updates over WebSockets, accepts saves.
import { buildBook, listBooks } from "./pipeline.ts";
import { watchTree } from "./watch.ts";

const WEB_DIR = new URL("../web/", import.meta.url);

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

// One path segment: no separators, no dot-dot, no leading dot.
function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

interface Client {
  socket: WebSocket;
  book: string;
  clientId: string;
}

interface PendingSave {
  text: string;
  clientId: string | null;
  timer: number;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
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
      await Deno.writeTextFile(`${booksRoot}/${book}/manuscript.md`, pending.text);
      // The watcher sees this write and broadcasts, tagged via recentWrites.
    }, saveDebounceMs);
    pendingSaves.set(book, pending);
    return Response.json({ ok: true });
  }

  async function buildMessage(book: string, origin: string | null): Promise<string> {
    try {
      const build = await buildBook(booksRoot, book);
      return JSON.stringify({ type: "update", origin, ...build });
    } catch (err) {
      // Bad metadata.json or a mid-write read must never kill the server —
      // push the failure to the preview instead (Global Constraints).
      return JSON.stringify({ type: "error", book, origin, message: String(err) });
    }
  }

  async function broadcast(book: string) {
    const origin = recentWrites.get(book) ?? null;
    recentWrites.delete(book);
    const message = await buildMessage(book, origin);
    for (const c of clients) {
      if (c.book === book && c.socket.readyState === WebSocket.OPEN) {
        c.socket.send(message);
      }
    }
  }

  const watcher = watchTree(booksRoot, (paths) => {
    const changed = new Set<string>();
    for (const p of paths) {
      if (!p.startsWith(absRoot + "/")) continue;
      const [book, ...rest] = p.slice(absRoot.length + 1).split("/");
      const file = rest.join("/");
      if (book && (file === "manuscript.md" || file === "metadata.json" || rest[0] === "images")) {
        changed.add(book);
      }
    }
    for (const book of changed) broadcast(book);
  });

  function handleWebSocket(req: Request, url: URL): Response {
    const book = url.searchParams.get("book");
    if (!book || !safeName(book)) {
      return new Response("missing or bad book param", { status: 400 });
    }
    const clientId = url.searchParams.get("client") ?? crypto.randomUUID();
    const { socket, response } = Deno.upgradeWebSocket(req);
    const client: Client = { socket, book, clientId };
    socket.onopen = async () => {
      clients.add(client);
      const message = await buildMessage(book, null);
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    };
    socket.onclose = () => clients.delete(client);
    socket.onerror = () => clients.delete(client);
    return response;
  }

  async function serveStatic(dirUrl: URL | string, name: string): Promise<Response> {
    if (!safeName(name)) return new Response("bad path", { status: 400 });
    try {
      const data = typeof dirUrl === "string"
        ? await Deno.readFile(`${dirUrl}/${name}`)
        : await Deno.readFile(new URL(name, dirUrl));
      const ext = name.slice(name.lastIndexOf("."));
      return new Response(data, {
        headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") return handleWebSocket(req, url);

    if (path === "/" || path === "/index.html") return serveStatic(WEB_DIR, "index.html");
    if (path.startsWith("/web/")) return serveStatic(WEB_DIR, path.slice("/web/".length));

    if (path === "/api/books" && req.method === "GET") {
      return Response.json({ books: await listBooks(booksRoot) });
    }

    const bookApi = path.match(/^\/api\/books\/([^/]+)$/);
    if (bookApi && req.method === "GET") {
      const book = bookApi[1]!;
      if (!safeName(book)) return new Response("bad path", { status: 400 });
      try {
        return Response.json(await buildBook(booksRoot, book));
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return new Response("book not found", { status: 404 });
        }
        return new Response(`build failed: ${String(err)}`, { status: 500 });
      }
    }

    const saveApi = path.match(/^\/api\/books\/([^/]+)\/manuscript$/);
    if (saveApi && req.method === "POST") return handleSave(saveApi[1]!, req);

    const image = path.match(/^\/books\/([^/]+)\/images\/([^/]+)$/);
    if (image && req.method === "GET") {
      const [, book, file] = image;
      if (!safeName(book!) || !safeName(file!)) return new Response("bad path", { status: 400 });
      return serveStatic(`${booksRoot}/${book}/images`, file!);
    }

    return new Response("not found", { status: 404 });
  }

  const server = Deno.serve({ port: opts.port ?? 8000, onListen: () => {} }, handleRequest);

  return {
    port: server.addr.port,
    async stop() {
      watcher.stop();
      for (const p of pendingSaves.values()) clearTimeout(p.timer);
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
