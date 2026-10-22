// bml.ts — headless CLI over server/pipeline.ts, for agents and scripts.
//   deno task bml check <book>            → diagnostics; exit 1 if any
//   deno task bml render <book> [out.html] [--edition e] → standalone HTML
//   deno task bml list                    → books, with their named editions
//   deno task bml new <slug>              → books/<slug>/ from templates/ (house-style metadata.json)
//   deno task bml import <file> [--slug s] [--chapters auto|N|none] [--flat] [--prose] [--force] → books/<slug>/ from a .txt/.md/.html/.epub
//   deno task bml edition <book> new <slug> [--from <edition>] → copy an edition under a new name
//   deno task bml export <book> [--edition e] [--sheet S] [--folios N|booklet] [--duplex short-edge|long-edge|none]
//                                [--flip F] [--reverse-backs] [--proof] [--pages N] [--out dir] [--force]
//                                → exit 1 on pagination problems unless --force
//   deno task bml epub <book> [--edition e] [--out dir] → books/<book>/export/book.epub
import { parseArgs } from "@std/cli/parse-args";
import { buildBook, listBooks, NotFoundError } from "./server/pipeline.ts";
import { toHtml } from "./server/export-html.ts";
import {
  createEdition,
  editionSlugs,
  editionTokens,
  listEditions,
  metadataPath,
  safeName,
} from "./server/editions.ts";
import { checkOnlySpans, parse } from "./parser/parser.ts";

export { toHtml } from "./server/export-html.ts";

// Test seam: lets tests point the CLI at a scratch books root instead of "books".
const BOOKS = Deno.env.get("BML_BOOKS") ?? "books";

export function formatDiagnostics(
  book: string,
  diags: { line: number; message: string }[],
): string {
  return diags.map((d) =>
    `${BOOKS}/${book}/manuscript.md:${d.line}: ${d.message}`
  ).join("\n");
}

const safeSlug = (t: string) =>
  t.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").split("-").slice(0, 4).join("-") || "book";

if (import.meta.main) {
  const a = parseArgs(Deno.args, {
    string: [
      "slug",
      "chapters",
      "sheet",
      "duplex",
      "flip",
      "out",
      "folios",
      "pages",
      "edition",
      "from",
    ],
    boolean: ["proof", "reverse-backs", "force", "flat", "prose"],
    unknown: (_arg, key) => {
      if (key !== undefined) {
        console.error(`unknown flag --${key}`);
        Deno.exit(2);
      }
      return true;
    },
  });
  const [cmd, book, out, sub] = a._.map(String);
  const edition = a.edition ?? null;
  if (edition !== null && !safeName(edition)) {
    console.error(`bad edition slug: ${edition}`);
    Deno.exit(2);
  }
  if (cmd === "list") {
    for (const b of await listBooks(BOOKS)) {
      console.log(b);
      for (const e of await listEditions(BOOKS, b)) {
        const row = [e.slug ?? "default", e.name, e.summary].filter(Boolean);
        console.log(`  └ ${row.join("  ")}`);
      }
    }
  } else if (cmd === "edition" && book && out === "new" && sub) {
    // `out` is the positional after <book>: here the sub-command "new".
    if (!safeName(sub)) {
      console.error(`bad edition slug: ${sub}`);
      Deno.exit(2);
    }
    const from = a.from ?? null;
    if (from !== null && !safeName(from)) {
      console.error(`bad edition slug: ${from}`);
      Deno.exit(2);
    }
    let source: unknown;
    try {
      source = JSON.parse(
        await Deno.readTextFile(metadataPath(BOOKS, book, from)),
      );
    } catch {
      console.error(
        `no such book or edition: ${book}${from ? `/${from}` : ""}`,
      );
      Deno.exit(1);
    }
    if (!await createEdition(BOOKS, book, sub, source)) {
      console.error(`edition already exists: ${book}/${sub}`);
      Deno.exit(1);
    }
    console.log(`created ${metadataPath(BOOKS, book, sub)}`);
  } else if (cmd === "new" && book) {
    const dir = `${BOOKS}/${book}`;
    await Deno.mkdir(`${dir}/images`, { recursive: true });
    await Deno.copyFile("templates/metadata.json", `${dir}/metadata.json`);
    await Deno.writeTextFile(
      `${dir}/manuscript.md`,
      `{matter: half-title}\n{title}\n${book}\n`,
      { createNew: true },
    );
    console.log(
      `created ${dir}/ — drop the source text in as download.txt, then use the convert-manuscript skill`,
    );
  } else if (cmd === "import" && book) {
    const { importSource } = await import("./server/import/mod.ts");
    const file = book;
    const name = file.slice(file.lastIndexOf("/") + 1);
    const chapters = a.chapters === undefined || a.chapters === "auto"
      ? "auto"
      : a.chapters === "none"
      ? "none"
      : parseInt(a.chapters, 10);
    const r = importSource(name, await Deno.readFile(file), {
      chapters,
      parts: a.flat ? false : undefined,
      verse: a.prose ? false : undefined,
    });
    const slug = a.slug ?? safeSlug(r.title);
    if (!safeName(slug)) {
      console.error(`bad slug: ${slug}`);
      Deno.exit(2);
    }
    const dir = `${BOOKS}/${slug}`;
    await Deno.mkdir(`${dir}/images`, { recursive: true });
    try {
      await Deno.copyFile("templates/metadata.json", `${dir}/metadata.json`);
    } catch {
      // keep an existing metadata.json: a re-import changes the manuscript only
    }
    try {
      await Deno.writeTextFile(`${dir}/manuscript.md`, r.manuscript, {
        createNew: !a.force,
      });
    } catch {
      console.error(`${dir}/manuscript.md exists; --force to replace it`);
      Deno.exit(1);
    }
    for (const [path, data] of Object.entries(r.images)) {
      await Deno.writeFile(`${dir}/${path}`, data);
    }
    const ext = name.slice(name.lastIndexOf("."));
    try {
      await Deno.copyFile(file, `${dir}/download${ext}`);
    } catch {
      // the source may already be there (re-import from the book folder)
    }
    console.log(`${dir}/manuscript.md`);
    for (const l of r.outline.summary) console.log(`  ${l}`);
    for (const rd of r.outline.readings) {
      console.log(`  ${rd.current ? "\u25cf" : "\u25cb"} ${rd.label}`);
    }
  } else if (cmd === "check" && book) {
    // check is manuscript-only (spec): no edition is chosen, so every {only}
    // span's content is parsed (§3.2.9) and a missing edition can't crash it.
    const doc = parse(
      await Deno.readTextFile(`${BOOKS}/${book}/manuscript.md`),
    );
    const tokens = editionTokens(await editionSlugs(BOOKS, book));
    const diags = [
      ...doc.diagnostics,
      ...checkOnlySpans(doc.onlySpans, tokens),
    ];
    if (doc.onlySpans.length) {
      console.error(formatDiagnostics(
        book,
        doc.onlySpans.map((s) => ({
          line: s.line,
          message: "experimental: {only}",
        })),
      ));
    }
    if (diags.length) console.error(formatDiagnostics(book, diags));
    console.log(`${book}: ${diags.length} diagnostic(s)`);
    Deno.exit(diags.length ? 1 : 0);
  } else if (cmd === "render" && book) {
    let b;
    try {
      b = await buildBook(BOOKS, book, { edition });
    } catch (e) {
      if (e instanceof NotFoundError) {
        console.error(`no such edition: ${book}/${edition}`);
        Deno.exit(1);
      }
      throw e;
    }
    if (b.diagnostics.length) {
      console.error(formatDiagnostics(book, b.diagnostics));
    }
    const path = out ??
      `${BOOKS}/${book}/render${edition ? `.${edition}` : ""}.html`;
    await Deno.writeTextFile(path, toHtml(b));
    console.log(`wrote ${path}`);
  } else if (cmd === "export" && book) {
    const { exportBook, formatSummary } = await import(
      "./server/print-export.ts"
    );
    const { formatProblem } = await import("./renderer/page-map-types.ts");
    try {
      const opts = {
        edition,
        folios: a.folios === "booklet"
          ? "booklet" as const
          : a.folios !== undefined
          ? Number(a.folios)
          : undefined,
        pages: a.pages !== undefined ? Number(a.pages) : undefined,
        sheet: a.sheet,
        duplex: a.duplex as "short-edge" | "long-edge" | "none" | undefined,
        flip: a.flip as "short-edge" | "long-edge" | undefined,
        reverseBacks: a["reverse-backs"] || undefined, // absent: the page section's
        proof: a.proof,
        out: a.out,
        force: a.force,
      };
      if (opts.pages !== undefined && !opts.proof) {
        console.error(`note: --pages is ignored unless --proof`);
      }
      const s = await exportBook(BOOKS, book, opts);
      // setup.duplex includes metadata's page.duplex, which the flags alone can't see
      if (opts.flip !== undefined && s.setup.duplex !== "none") {
        console.error(`note: --flip is ignored unless duplex is none`);
      }
      if (opts.reverseBacks && s.setup.duplex !== "none") {
        console.error(`note: --reverse-backs is ignored unless duplex is none`);
      }
      if (s.diagnostics) {
        console.error(
          `${s.diagnostics} parse diagnostic(s) — run: bml check ${book}`,
        );
      }
      for (const p of s.pagination) {
        console.error(`warning: ${formatProblem(p)}`);
      }
      console.log(formatSummary(book, s));
      for (const f of s.files) console.log(`wrote ${f}`);
    } catch (e) {
      console.error(`export failed: ${(e as Error).message}`);
      Deno.exit(1);
    }
  } else if (cmd === "epub" && book) {
    const { exportEpub } = await import("./server/epub-export.ts");
    try {
      const s = await exportEpub(BOOKS, book, { edition, out: a.out });
      if (s.diagnostics) {
        console.error(
          `${s.diagnostics} parse diagnostic(s) — run: bml check ${book}`,
        );
      }
      console.log(`wrote ${s.file} (${s.documents} documents)`);
    } catch (e) {
      console.error(`epub failed: ${(e as Error).message}`);
      Deno.exit(1);
    }
  } else {
    console.error(
      "usage: bml list | new <slug> | import <file> [--slug s] [--chapters auto|N|none] [--flat] [--prose] [--force] | edition <book> new <slug> [--from e] | check <book> | render <book> [out.html] [--edition e] | export <book> [--edition e] [--sheet S] [--folios N|booklet] [--duplex short-edge|long-edge|none] [--flip F] [--reverse-backs] [--proof] [--pages N] [--out dir] [--force] | epub <book> [--edition e] [--out dir]",
    );
    Deno.exit(2);
  }
}
