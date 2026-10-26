---
name: bml
description: Use when running the bml CLI or working on a book on disk in Wynkyn — adding a new book, importing a .txt/.md/.html/.epub/.docx, checking a manuscript, rendering standalone HTML, exporting the print PDFs or the EPUB, proofing a new printer, or making an edition. Also use for `deno task fonts` and before changing bml.ts or what a subcommand does.
---

# The `bml` CLI

`deno task bml <command>` (`bml.ts`). Every command works over `books/` in the
checkout; in a worktree that is the symlink `deno task setup` makes to the main
library. `BML_BOOKS=<dir>` points it elsewhere (the tests' seam).

## Commands

- `bml list` — books on disk, with their named editions.
- `bml new <slug> [--theme t]` — scaffold `books/<slug>/` from
  `templates/metadata.json` (house style, or preset theme `t` applied, spec
  §4.13).
- `bml import <file> [--slug s] [--theme t] [--chapters auto|N|none] [--flat] [--prose] [--force]`
  — a book from a .txt/.md/.html/.epub/.docx: `server/import/` reads it into
  blocks, finds the chapters, writes `manuscript.md` in the house shape with
  `%% check:` notes (spec §7.9). The browser app runs the same code from Create a new
  manuscript, on a file or a web address fetched or pasted. `--force`
  re-imports over an existing manuscript.
- `bml check <book>` — parse diagnostics as `file:line: msg`; exit 1 on any. Run
  it after every manuscript edit.
- `bml render <book> [out] [--edition e]` — standalone HTML (default
  `books/<book>/render.html`, or `render.<e>.html`); open in a browser to
  paginate.
- `bml export <book> [--edition e] [--proof] [--sheet S] [--fold F] [--folios N|booklet] [--duplex M]`
  — the print export (`server/print-export.ts`, `server/imposition.ts`,
  `server/pdf.ts`) → `books/<book>/export/` (or `export/<e>/`): `book.pdf`, the
  sheet PDFs and `page-map.json` (the settled seed, keyed by a hash of the
  render's inputs, so a re-export of an unchanged book takes one pass). Needs
  Google Chrome installed; fails on page-map problems unless `--force`.
- `bml epub <book> [--edition e] [--out dir]` — the e-book export
  (`server/epub-export.ts`, spec §7.8): the same render split into XHTML files
  and zipped with fflate → `book.epub` in the same export dir. EPUB 3,
  reflowable, no Chrome needed. `brew install epubcheck` enables the validator
  test in `server/epub-export_test.ts`.
- `bml edition <book> new <slug> [--from e]` — copy an edition under a new
  name.

`deno task fonts` (not a `bml` command) regenerates `metadata/fonts-catalog.ts`,
every Google family for the font picker, from Google's public catalog.

## Editions

Styling-only variants of one book: `metadata.json` is the unnamed edition,
`editions/<slug>.json` are named ones; the manuscript and images are shared.
`--edition e` picks one for `render`, `export` and `epub`.

## Adding a book

1. `deno task bml new <slug>`.
2. Put the source text at `books/<slug>/download.txt`.
3. The `convert-manuscript` skill writes `manuscript.md` (or `bml import` for a
   first pass, then the skill's finish checks).
4. Style afterwards in the app.

## Printing it

On a new printer, `bml export <slug> --proof` first, check one signature by hand
(printed, folded, nested, read in order), then the real export. The
`bookbinding` skill has the fold and duplex model and what is not yet proven on
paper. In the browser, the Publish view prints from the live preview instead;
sheet PDFs and proofs on disk are `bml export`'s only.
