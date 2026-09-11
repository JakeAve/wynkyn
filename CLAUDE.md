# book-editor-app

Web app for editing and printing hand-bound books. A book is `books/<slug>/`
with `manuscript.md` (BML — semantic markup, spec §3 / `bml-spec-v06.md`),
`metadata.json` (all styling, spec §4), and `images/`. `books/` is gitignored.

`book-renderer-spec.md` is the source of truth; when code and spec disagree,
ask. Plans 0–5 and 7 are done (parser, live server, editor, config panel,
sentinel styling, print export, table of contents); Plan 6 (integration &
polish) is open. `bml export` is the print-export command
(`server/print-export.ts`, `server/imposition.ts`, `server/pdf.ts`).

Page setup lives in one `page` section: `size`, `margins`, `sheet`,
`folios-per-signature`, `duplex`. The retired `print` section is folded into it
on load (`metadata/upgrade.ts`), so older books still work and rewrite
themselves on the next save.

## Layout

- `parser/` BML → `BmlDocument` tree (pure, `parse(source)`)
- `metadata/` metadata.json → CSS (`generateDomCSS/PagedCSS/FontLinks`);
  `page-setup.ts` resolves the `page` section (page + sheet + signature, spec
  §4.3) into the derived imposition, shared with `web/` and print export
- `renderer/` tree → HTML body (`render(doc, opts)`), `base.css`; `plates.js` is
  the one Paged.js handler (full-page illustrations as plates), inlined by
  `toHtml` and imported by `web/src/app.ts`
- `server/` `pipeline.ts` (`buildBook`) + `dev-server.ts` (HTTP/WebSocket,
  watches book files)
- `web/` browser app; `web/src/app.ts` bundles to `web/app.js` (gitignored).
  Paged.js paginates the preview.

## Commands

- `deno task test` all tests (`*_test.ts` next to each module)
- `deno task dev` build client + live server at http://localhost:8000
- `deno task bml list` books on disk
- `deno task bml new <slug>` scaffold `books/<slug>/` from
  `templates/metadata.json` (house style)
- `deno task bml check <book>` parse diagnostics as `file:line: msg`; exit 1 on
  any — run after every manuscript edit
- `deno task bml render <book> [out] [--edition e]` standalone HTML (default
  `books/<book>/render.html`, or `render.<e>.html`); open in a browser to
  paginate
- `deno task bml export <book> [--edition e] [--proof] [--sheet S] [--folios N] [--duplex M]`
  → `books/<book>/export/` (or `export/<e>/`); needs Google Chrome installed
- `deno task bml edition <book> new <slug> [--from e]` copy an edition under a
  new name. Editions are styling-only variants: `metadata.json` is the unnamed
  edition, `editions/<slug>.json` are named ones, manuscript and images shared.

## Adding a book

`deno task bml new <slug>`, put the source text at `books/<slug>/download.txt`,
then the `convert-manuscript` skill (`.claude/skills/`) writes `manuscript.md`.
Style afterwards in the app. Print: `bml export <slug> --proof` first on a new
printer, check one signature by hand, then the real export.

## Conventions

- Deno only, strict TS, `noUncheckedIndexedAccess`. No new deps without reason.
- Tests are plain `Deno.test` with `jsr:@std/assert`. Fixture book:
  `server/testdata/demo-book`. `testdata/common-sense` and
  `testdata/great-gatsby` are the tracked full-grammar corpus (`books_test.ts`)
  — public domain, kept in sync by hand with `books/` when styling changes.
- CI (`.github/workflows/ci.yml`) runs `build:web` + `test` on push/PR; it has
  no Chrome, so the PDF tests self-skip there.
- Sample manuscripts start from Project Gutenberg `download.txt` in the book
  dir; strip the Gutenberg header/footer, never leave it in `manuscript.md`.
- Commit messages: `feat:|fix:|test:|style:|chore:` prefix, present tense.
