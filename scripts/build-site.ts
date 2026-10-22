// scripts/build-site.ts — `deno task build:site`: the hosted app as plain
// files in dist/. Nothing runs on the server: the browser runs the book
// service over the author's own folder (web/src/backend.ts), so the site is
// the shell, the bundle, Paged.js and the two files the service reads.
const OUT = "dist";
const FILES: Record<string, string> = {
  "web/index.html": "index.html",
  "web/app.js": "web/app.js",
  "web/app.css": "web/app.css",
  "vendor/pagedjs/paged.js": "vendor/paged.js",
  "renderer/base.css": "renderer/base.css",
  "templates/metadata.json": "templates/metadata.json",
};

await Deno.remove(OUT, { recursive: true }).catch(() => {});
for (const [src, dest] of Object.entries(FILES)) {
  const to = `${OUT}/${dest}`;
  await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  await Deno.copyFile(src, to);
}
console.log(`${OUT}/: ${Object.keys(FILES).length} files`);
