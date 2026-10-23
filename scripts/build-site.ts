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
  // Discoverability: what crawlers, link previews and installs look for.
  "web/robots.txt": "robots.txt",
  "web/sitemap.xml": "sitemap.xml",
  "web/manifest.webmanifest": "manifest.webmanifest",
  "web/icon.svg": "icon.svg",
  "web/icon-192.png": "icon-192.png",
  "web/icon-512.png": "icon-512.png",
  "web/apple-touch-icon.png": "apple-touch-icon.png",
  ".github/readme/front-matter.png": "og.png",
  "web/app.js": "web/app.js",
  "web/app.css": "web/app.css",
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
