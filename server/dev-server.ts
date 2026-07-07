// server/dev-server.ts — live dev server (spec §5.4, §6): serves the app shell,
// watches books, rebuilds on change, pushes updates over WebSockets, accepts saves.
import { buildBook, listBooks } from "./pipeline.ts";

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

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const booksRoot = opts.booksRoot ?? "books";
  await Deno.stat(booksRoot); // fail fast at startup if the root is missing

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
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  const running = await startServer({ port: Number(Deno.args[0] ?? "8000") });
  console.log(`book editor dev server → http://localhost:${running.port}/`);
}
