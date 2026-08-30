// bml.ts — headless CLI over server/pipeline.ts, for agents and scripts.
//   deno task bml check <book>            → diagnostics; exit 1 if any
//   deno task bml render <book> [out.html] → standalone HTML (Paged.js polyfill paginates on open)
//   deno task bml list
import { buildBook, listBooks } from "./server/pipeline.ts";

const BOOKS = "books";

export function toHtml(b: Awaited<ReturnType<typeof buildBook>>): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${b.bookTitle}</title>
${b.fontLinks}
<style>${b.baseCss}\n${b.domCss}\n${b.pagedCss}</style>
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>
</head><body>${b.html}</body></html>`;
}

export function formatDiagnostics(book: string, diags: { line: number; message: string }[]): string {
  return diags.map((d) => `${BOOKS}/${book}/manuscript.md:${d.line}: ${d.message}`).join("\n");
}

if (import.meta.main) {
  const [cmd, book, out] = Deno.args;
  if (cmd === "list") {
    console.log((await listBooks(BOOKS)).join("\n"));
  } else if ((cmd === "check" || cmd === "render") && book) {
    const b = await buildBook(BOOKS, book);
    if (b.diagnostics.length) console.error(formatDiagnostics(book, b.diagnostics));
    if (cmd === "check") {
      console.log(`${book}: ${b.diagnostics.length} diagnostic(s)`);
      Deno.exit(b.diagnostics.length ? 1 : 0);
    }
    const path = out ?? `${BOOKS}/${book}/render.html`;
    await Deno.writeTextFile(path, toHtml(b));
    console.log(`wrote ${path}`);
  } else {
    console.error("usage: bml list | check <book> | render <book> [out.html]");
    Deno.exit(2);
  }
}
