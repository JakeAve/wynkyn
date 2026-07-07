// scripts/preview.ts — THROWAWAY Paged.js smoke-check harness (Plan 0, Task 13).
// Usage: deno run --allow-read --allow-write scripts/preview.ts common-sense
import { parse } from "../parser/parser.ts";
import { loadMetadata } from "../metadata/loader.ts";
import { generateDomCSS, generateFontLinks, generatePagedCSS } from "../metadata/css-generator.ts";
import { render } from "../renderer/render.ts";

const book = Deno.args[0] ?? "common-sense";
const src = await Deno.readTextFile(`books/${book}/manuscript.md`);
const doc = parse(src);
for (const d of doc.diagnostics) console.warn(`line ${d.line}: ${d.message}`);

const meta = (await loadMetadata(`books/${book}`)) ?? {};

// Image resolution happens here, not in render() — spec §4.11 item 8.
const images: Record<string, string> = {};
try {
  for await (const f of Deno.readDir(`books/${book}/images`)) {
    if (f.isFile) images[f.name.replace(/\.[^.]+$/, "")] ??= `images/${f.name}`;
  }
} catch {
  // no images directory — placeholders will render
}

let bookTitle = book;
outer: for (const m of doc.frontMatter) {
  for (const c of m.children) {
    if (c.kind === "component" && c.name === "title") {
      bookTitle = c.inlines.map((i) => (i.kind === "text" ? i.text : "")).join("");
      break outer;
    }
  }
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>preview: ${bookTitle}</title>
${generateFontLinks(meta)}
<style>${await Deno.readTextFile("renderer/base.css")}</style>
<style>${generateDomCSS(meta)}</style>
<style>${generatePagedCSS(meta, { bookTitle })}</style>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>
</head>
<body>
${render(doc, { numbering: meta.numbering, notes: meta.notes, images })}
</body>
</html>
`;
await Deno.writeTextFile(`books/${book}/preview.html`, html);
console.log(`wrote books/${book}/preview.html — open it in Chrome`);
