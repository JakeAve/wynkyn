// scripts/serve-site.ts — `deno task serve:site`: dist/ the way any static
// host serves it, files or 404 and no API, so the app runs the book service
// itself. web/src/local-browser_test.ts drives the same server.
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
};

export function serveSite(
  dist: URL,
  port: number,
): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ port, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    try {
      const body = await Deno.readFile(new URL(file, dist));
      const ext = file.slice(file.lastIndexOf(".") + 1);
      return new Response(body, {
        headers: { "content-type": TYPES[ext] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT")) || 8010;
  serveSite(new URL("../dist/", import.meta.url), port);
  console.log(`wynkyn site (no server) → http://localhost:${port}/`);
}
