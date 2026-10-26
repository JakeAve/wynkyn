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
  // The pages that can rank: plain HTML at the root. The app sits at /app/.
  "web/site/index.html": "index.html",
  "web/site/about.html": "about/index.html",
  "web/site/faq.html": "faq/index.html",
  "web/site/site.css": "web/site.css",
  ".github/readme/front-matter.png": "web/front-matter.png",
  "web/index.html": "app/index.html",
  // For crawlers; the icons, manifest and OG image live under web/brand/.
  "web/robots.txt": "robots.txt",
  "web/sitemap.xml": "sitemap.xml",
  "web/app.js": "web/app.js",
  "web/tokens.css": "web/tokens.css",
  "web/app.css": "web/app.css",
  // The component sheet: the chrome's own CSS on every component (design-language.md §6).
  "web/components.html": "web/components.html",
  "web/brand/mark.svg": "web/brand/mark.svg",
  "web/brand/icon-32.png": "web/brand/icon-32.png",
  "web/brand/apple-touch-icon.png": "web/brand/apple-touch-icon.png",
  "web/brand/icon-512.png": "web/brand/icon-512.png",
  "web/brand/site.webmanifest": "web/brand/site.webmanifest",
  "web/brand/og.png": "web/brand/og.png",
  "vendor/pagedjs/paged.js": "vendor/paged.js",
  "vendor/scowl/en.txt": "vendor/words-en.txt",
  // The faces web/tokens.css names, with their licences, at the same paths.
  ...Object.fromEntries(
    [
      "alegreya-sans/alegreya-sans-400.woff2",
      "alegreya-sans/alegreya-sans-400i.woff2",
      "alegreya-sans/alegreya-sans-500.woff2",
      "alegreya-sans/alegreya-sans-700.woff2",
      "alegreya-sans/OFL.txt",
      "alegreya/alegreya.woff2",
      "alegreya/alegreya-italic.woff2",
      "alegreya/OFL.txt",
      "im-fell-great-primer/im-fell-great-primer.woff2",
      "im-fell-great-primer/im-fell-great-primer-italic.woff2",
      "im-fell-great-primer/OFL.txt",
    ].map((f) => [`vendor/fonts/${f}`, `vendor/fonts/${f}`]),
  ),
  "renderer/base.css": "renderer/base.css",
  "templates/metadata.json": "templates/metadata.json",
};

// The file a request path maps to, or null. "/" and "/about/" read their
// index.html; a bare "/about" comes back as "/about/" so the caller redirects.
export function siteFile(path: string): string | null {
  const dest = path.endsWith("/")
    ? `${path.slice(1)}index.html`
    : path.slice(1);
  if (dest in DEST) return DEST[dest]!;
  return `${dest}/index.html` in DEST ? `${path}/` : null;
}
const DEST = Object.fromEntries(
  Object.entries(FILES).map(([src, dest]) => [dest, src]),
);

// Prefixes root-absolute links to the site's own files with `base`: "/web/…",
// '/app/', `/renderer/…` in pages, styles, the manifest and the bundle, and a
// page's href="/". Other root paths ("/api/…", the bundle's "/" separators)
// are left alone.
const TOP = [...new Set(Object.values(FILES).map((d) => d.split("/")[0]!))];
const OWN = new RegExp(
  `(["'\`(])/(?=(?:${TOP.join("|").replaceAll(".", "\\.")})[/"'\`)])`,
  "g",
);
export function rebase(text: string, base: string): string {
  base = base.replace(/\/?$/, "/");
  if (base === "/") return text;
  return text.replace(OWN, `$1${base}`).replace(
    /((?:href|src)=")\/"/g,
    `$1${base}"`,
  );
}

export async function build(base = "/"): Promise<void> {
  await Deno.remove(OUT, { recursive: true }).catch(() => {});
  for (const [src, dest] of Object.entries(FILES)) {
    const to = `${OUT}/${dest}`;
    await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true });
    if (/\.(html|css|webmanifest)$/.test(dest) || dest === "web/app.js") {
      await Deno.writeTextFile(to, rebase(await Deno.readTextFile(src), base));
    } else await Deno.copyFile(src, to);
  }
  console.log(`${OUT}/: ${Object.keys(FILES).length} files`);
}

// `--base=/wynkyn/` builds for a host that serves the site under a folder
// (GitHub Pages); the links stay root-absolute, under that folder.
if (import.meta.main) {
  const base = Deno.args.find((a) => a.startsWith("--base="))?.slice(7);
  await build(base);
}
