// bml.ts — headless CLI over server/pipeline.ts, for agents and scripts.
//   deno task bml check <book>            → diagnostics; exit 1 if any
//   deno task bml render <book> [out.html] → standalone HTML (Paged.js polyfill paginates on open)
//   deno task bml list
//   deno task bml new <slug>              → books/<slug>/ from templates/ (house-style metadata.json)
//   deno task bml export <book> [--sheet S] [--folios N] [--duplex short-edge|long-edge|none]
//                                [--flip F] [--reverse-backs] [--proof] [--pages N] [--out dir]
import { parseArgs } from "@std/cli/parse-args";
import { buildBook, listBooks, toHtml } from "./server/pipeline.ts";

export { toHtml } from "./server/pipeline.ts";

const BOOKS = "books";

export function formatDiagnostics(book: string, diags: { line: number; message: string }[]): string {
  return diags.map((d) => `${BOOKS}/${book}/manuscript.md:${d.line}: ${d.message}`).join("\n");
}

if (import.meta.main) {
  const a = parseArgs(Deno.args, {
    string: ["sheet", "duplex", "flip", "out", "folios", "pages"],
    boolean: ["proof", "reverse-backs"],
    unknown: (arg, key) => {
      if (key !== undefined) {
        console.error(`unknown flag --${key}`);
        Deno.exit(2);
      }
      return true;
    },
  });
  const [cmd, book, out] = a._.map(String);
  if (cmd === "list") {
    console.log((await listBooks(BOOKS)).join("\n"));
  } else if (cmd === "new" && book) {
    const dir = `${BOOKS}/${book}`;
    await Deno.mkdir(`${dir}/images`, { recursive: true });
    await Deno.copyFile("templates/metadata.json", `${dir}/metadata.json`);
    await Deno.writeTextFile(`${dir}/manuscript.md`, `{matter: half-title}\n{title}\n${book}\n`, { createNew: true });
    console.log(`created ${dir}/ — drop the source text in as download.txt, then use the convert-manuscript skill`);
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
  } else if (cmd === "export" && book) {
    const { exportBook, formatSummary } = await import("./server/print-export.ts");
    try {
      const opts = {
        folios: a.folios !== undefined ? Number(a.folios) : undefined,
        pages: a.pages !== undefined ? Number(a.pages) : undefined,
        sheet: a.sheet,
        duplex: a.duplex as "short-edge" | "long-edge" | "none" | undefined,
        flip: a.flip as "short-edge" | "long-edge" | undefined,
        reverseBacks: a["reverse-backs"],
        proof: a.proof,
        out: a.out,
      };
      const duplex = opts.duplex ?? "short-edge";
      if (opts.flip !== undefined && duplex !== "none") console.error(`note: --flip is ignored unless --duplex none`);
      if (opts.pages !== undefined && !opts.proof) console.error(`note: --pages is ignored unless --proof`);
      if (opts.reverseBacks && duplex !== "none") console.error(`note: --reverse-backs is ignored unless --duplex none`);
      const s = await exportBook(BOOKS, book, opts);
      if (s.diagnostics) console.error(`${s.diagnostics} parse diagnostic(s) — run: bml check ${book}`);
      console.log(formatSummary(book, s, s.resolved));
      for (const f of s.files) console.log(`wrote ${f}`);
    } catch (e) {
      console.error(`export failed: ${(e as Error).message}`);
      Deno.exit(1);
    }
  } else {
    console.error(
      "usage: bml list | new <slug> | check <book> | render <book> [out.html] | export <book> [--sheet S] [--folios N] [--duplex short-edge|long-edge|none] [--flip F] [--reverse-backs] [--proof] [--pages N] [--out dir]",
    );
    Deno.exit(2);
  }
}
