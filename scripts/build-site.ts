// scripts/build-site.ts — `deno task build:site`: the hosted app as plain
// files in dist/. Nothing runs on the server: the browser runs the book
// service over the author's own folder (web/src/backend.ts), so the site is
// the shell, the bundle, Paged.js and the two files the service reads.
const OUT = "dist";
export const FILES: Record<string, string> = {
  // For agents and tooling, not the app: /llms.txt is the entry point.
  "web/llms.txt": "llms.txt",
  "book-renderer-spec.md": "spec.md",
  ".claude/skills/convert-manuscript/SKILL.md": "convert-manuscript.md",
  "web/index.html": "index.html",
  "web/app.js": "web/app.js",
  "web/app.css": "web/app.css",
  "web/brand/mark.svg": "web/brand/mark.svg",
  "web/brand/icon-32.png": "web/brand/icon-32.png",
  "web/brand/apple-touch-icon.png": "web/brand/apple-touch-icon.png",
  "web/brand/icon-512.png": "web/brand/icon-512.png",
  "web/brand/site.webmanifest": "web/brand/site.webmanifest",
  "web/brand/og.png": "web/brand/og.png",
  "vendor/pagedjs/paged.js": "vendor/paged.js",
  "renderer/base.css": "renderer/base.css",
  "templates/metadata.json": "templates/metadata.json",
};

if (import.meta.main) await build();

export async function build(): Promise<void> {
  await Deno.remove(OUT, { recursive: true }).catch(() => {});
  for (const [src, dest] of Object.entries(FILES)) {
    const to = `${OUT}/${dest}`;
    await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true });
    await Deno.copyFile(src, to);
  }
  console.log(`${OUT}/: ${Object.keys(FILES).length} files`);
}
