// server/dev-server.ts — the local server (spec §5.4, §6): HTTP + WebSockets
// in front of a BookService over the books/ folder, plus the app shell and the
// Chrome-driven exports, which only exist here (the hosted app is static and
// prints from the browser).
import { NotFoundError } from "./pipeline.ts";
import { BookService, ServiceError } from "./book-service.ts";
import { diskStore } from "./store.ts";
import { defaultPort } from "./port.ts";
import type { ExportOptions } from "./print-export.ts";
import { installedFonts } from "./local-fonts.ts";
import { formatProblem, PaginationError } from "../renderer/page-map-types.ts";
import { safeName } from "./editions.ts";

const WEB_DIR = new URL("../web/", import.meta.url);
const PAGED_DIR = new URL("../vendor/pagedjs/", import.meta.url);
const TEMPLATE = new URL("../templates/metadata.json", import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};
const contentType = (name: string) =>
  CONTENT_TYPES[name.slice(name.lastIndexOf("."))] ??
    "application/octet-stream";

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
  const service = new BookService({
    store: diskStore(booksRoot),
    saveDebounceMs: opts.saveDebounceMs,
  });

  async function json(req: Request): Promise<Record<string, unknown>> {
    try {
      return await req.json();
    } catch {
      throw new ServiceError(400, "invalid JSON body");
    }
  }

  // book/edition keys with an export running; one at a time each.
  const exporting = new Set<string>();
  const exportDir = (book: string, edition: string | null) =>
    `${booksRoot}/${book}/export${edition === null ? "" : `/${edition}`}`;

  // The Publish tab's print export (spec §7.7): `bml export` behind an
  // endpoint, so both write the same files. The body is { proof?, force?,
  // pages? }. Imported on use: Chrome and pdf-lib never load otherwise.
  async function handleExport(
    book: string,
    edition: string | null,
    req: Request,
  ): Promise<Response> {
    const body = await json(req);
    const key = `${book}/${edition}`;
    if (exporting.has(key)) {
      return new Response("an export is already running", { status: 409 });
    }
    exporting.add(key);
    try {
      const { exportBook, formatSummary } = await import("./print-export.ts");
      await service.flushMetadata(book, edition); // the export reads the file
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
    const key = `${book}/${edition}`;
    if (exporting.has(key)) {
      return new Response("an export is already running", { status: 409 });
    }
    exporting.add(key);
    try {
      const { exportEpub } = await import("./epub-export.ts");
      await service.flushMetadata(book, edition);
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

  function handleWebSocket(req: Request, url: URL): Response {
    const book = url.searchParams.get("book");
    const edition = url.searchParams.get("edition");
    if (!book || !safeName(book) || (edition !== null && !safeName(edition))) {
      return new Response("missing or bad book/edition param", { status: 400 });
    }
    const clientId = url.searchParams.get("client") ?? crypto.randomUUID();
    const { socket, response } = Deno.upgradeWebSocket(req);
    let unsubscribe = () => {};
    socket.onopen = () => {
      unsubscribe = service.subscribe(book, edition, clientId, (m) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(m));
        }
      });
    };
    socket.onclose = () => unsubscribe();
    socket.onerror = () => unsubscribe();
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
      return new Response(data, {
        headers: { "content-type": contentType(name) },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const edition = url.searchParams.get("edition");

    if (path === "/ws") return handleWebSocket(req, url);

    if (path === "/" || path === "/index.html") {
      return serveStatic(WEB_DIR, "index.html");
    }
    if (path === "/vendor/paged.js") return serveStatic(PAGED_DIR, "paged.js");
    // What the app fetches when it runs the service itself (see scripts/build-site.ts).
    if (path === "/renderer/base.css") {
      return serveStatic(new URL("../renderer/", import.meta.url), "base.css");
    }
    if (path === "/templates/metadata.json") {
      return serveStatic(
        new URL("../templates/", import.meta.url),
        "metadata.json",
      );
    }
    if (path.startsWith("/web/")) {
      return serveStatic(WEB_DIR, path.slice("/web/".length));
    }
    // Site files the head links at the root (icons, manifest, robots).
    if (/^\/[\w.-]+\.(svg|png|webmanifest|txt|xml)$/.test(path)) {
      return serveStatic(WEB_DIR, path.slice(1));
    }

    if (path === "/api/books" && req.method === "GET") {
      return Response.json({ books: await service.list() });
    }
    if (path === "/api/books" && req.method === "POST") {
      const { slug, title } = await json(req);
      if (typeof slug !== "string" || !safeName(slug)) {
        return new Response("bad book slug", { status: 400 });
      }
      const made = await service.createBook(
        slug,
        await Deno.readTextFile(TEMPLATE),
        typeof title === "string" ? title : slug,
      );
      return made
        ? Response.json({ ok: true }, { status: 201 })
        : new Response("book already exists", { status: 409 });
    }
    if (path === "/api/fonts" && req.method === "GET") {
      return Response.json({ installed: await installedFonts() });
    }

    const m = (re: RegExp) => path.match(re)?.slice(1) as string[] | undefined;
    let p: string[] | undefined;

    if ((p = m(/^\/api\/books\/([^/]+)$/)) && req.method === "GET") {
      return Response.json(await service.build(p[0]!, edition));
    }

    if ((p = m(/^\/api\/books\/([^/]+)\/manuscript$/))) {
      if (req.method === "GET") {
        return Response.json(await service.manuscript(p[0]!));
      }
      if (req.method === "POST") {
        const body = await json(req);
        if (typeof body.text !== "string") {
          return new Response(
            "body must be { text: string, clientId?: string, base?: string }",
            { status: 400 },
          );
        }
        const r = await service.saveManuscript(p[0]!, {
          text: body.text,
          clientId: typeof body.clientId === "string" ? body.clientId : null,
          base: typeof body.base === "string" ? body.base : null,
        });
        return Response.json(r, { status: "conflict" in r ? 409 : 200 });
      }
    }

    // An import done in the page: the manuscript and base64 images (§7.9).
    if ((p = m(/^\/api\/books\/([^/]+)\/import$/)) && req.method === "POST") {
      const body = await json(req);
      if (
        typeof body.manuscript !== "string" || body.images === null ||
        typeof body.images !== "object"
      ) {
        return new Response(
          "body must be { manuscript: string, images: {path: base64} }",
          { status: 400 },
        );
      }
      const images: Record<string, Uint8Array> = {};
      for (const [path, b64] of Object.entries(body.images)) {
        if (typeof b64 !== "string") {
          return new Response("bad image", { status: 400 });
        }
        images[path] = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      }
      const made = await service.importBook(
        p[0]!,
        await Deno.readTextFile(TEMPLATE),
        { manuscript: body.manuscript, images },
      );
      return made
        ? Response.json({ ok: true }, { status: 201 })
        : new Response("book already exists", { status: 409 });
    }

    // The unnamed edition's metadata and a named edition's: same handlers.
    if (
      (p = m(/^\/api\/books\/([^/]+)\/metadata$/)) ||
      (p = m(/^\/api\/books\/([^/]+)\/editions\/([^/]+)\/metadata$/))
    ) {
      const [book, ed = null] = p;
      if (req.method === "GET") {
        return Response.json(await service.metadata(book!, ed));
      }
      if (req.method === "POST") {
        const { sections } = await json(req);
        if (
          sections === null || typeof sections !== "object" ||
          Array.isArray(sections)
        ) {
          return new Response("body must be { sections: object }", {
            status: 400,
          });
        }
        return Response.json({
          ok: true,
          ...await service.saveMetadata(book!, ed, sections),
        });
      }
    }

    if ((p = m(/^\/api\/books\/([^/]+)\/editions$/))) {
      if (req.method === "GET") {
        return Response.json({ editions: await service.editions(p[0]!) });
      }
      if (req.method === "POST") {
        const { slug, from } = await json(req);
        if (typeof slug !== "string") {
          return new Response("bad edition slug", { status: 400 });
        }
        // "default" names the unnamed edition here, as in the rename route.
        await service.createEdition(
          p[0]!,
          slug,
          typeof from === "string" && from !== "default" ? from : null,
        );
        return Response.json({ ok: true }, { status: 201 });
      }
    }

    if (
      (p = m(/^\/api\/books\/([^/]+)\/editions\/([^/]+)$/)) &&
      req.method === "DELETE"
    ) {
      await service.deleteEdition(p[0]!, p[1]!);
      return Response.json({ ok: true });
    }

    if (
      (p = m(/^\/api\/books\/([^/]+)\/editions\/([^/]+)\/rename$/)) &&
      req.method === "POST"
    ) {
      const body = await json(req);
      if (p[1] === "default") {
        if (typeof body.name !== "string") {
          return new Response("body must be { name: string }", { status: 400 });
        }
        await service.renameDefault(p[0]!, body.name);
      } else {
        if (typeof body.slug !== "string") {
          return new Response("bad edition slug", { status: 400 });
        }
        await service.renameEdition(p[0]!, p[1]!, body.slug);
      }
      return Response.json({ ok: true });
    }

    if ((p = m(/^\/api\/books\/([^/]+)\/export(?:\/([^/]+))?$/))) {
      const [book, file] = p;
      if (!safeName(book!) || (edition !== null && !safeName(edition))) {
        return new Response("bad path", { status: 400 });
      }
      if (!file && req.method === "POST") {
        return handleExport(book!, edition, req);
      }
      if (file && req.method === "GET") {
        return serveStatic(exportDir(book!, edition), file);
      }
    }

    if ((p = m(/^\/api\/books\/([^/]+)\/epub$/)) && req.method === "POST") {
      if (!safeName(p[0]!) || (edition !== null && !safeName(edition))) {
        return new Response("bad path", { status: 400 });
      }
      return handleEpub(p[0]!, edition);
    }

    if (
      (p = m(/^\/books\/([^/]+)\/images\/([^/]+)$/)) && req.method === "GET"
    ) {
      const data = await service.image(p[0]!, p[1]!);
      return data === null
        ? new Response("not found", { status: 404 })
        : new Response(data, {
          headers: { "content-type": contentType(p[1]!) },
        });
    }

    return new Response("not found", { status: 404 });
  }

  async function handleRequest(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof ServiceError) {
        return new Response(err.message, { status: err.status });
      }
      if (err instanceof NotFoundError) {
        return new Response(err.message, { status: 404 });
      }
      return new Response(String(err), { status: 500 });
    }
  }

  const server = Deno.serve(
    { port: opts.port ?? 8000, onListen: () => {} },
    handleRequest,
  );

  return {
    port: server.addr.port,
    async stop() {
      await service.stop();
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  const running = await startServer({ port: defaultPort() });
  console.log(`wynkyn dev server → http://localhost:${running.port}/`);
}
