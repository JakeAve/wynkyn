# Wynkyn

Web app for editing and printing hand-bound books. A book is `books/<slug>/`
with `manuscript.md` (BML — semantic markup, spec §3), `metadata.json` (all
styling, spec §4), and `images/`. `books/` is gitignored.

`book-renderer-spec.md` is the source of truth; when code and spec disagree,
ask. Plans 0–5 and 7 are done (parser, live server, editor, config panel,
sentinel styling, print export, table of contents); Plan 6 (integration &
polish) is open. `bml export` is the print-export command
(`server/print-export.ts`, `server/imposition.ts`, `server/pdf.ts`); `bml epub`
is the e-book export (`server/epub-export.ts`, spec §7.8), the same render split
into XHTML files and zipped with fflate.

Page setup lives in one `page` section: `size`, `margins`, `sheet`,
`folios-per-signature` (a number or `"booklet"`), `duplex`, and for backs
printed by hand `flip` and `reverse-backs`. The retired `print` section is
folded into it on load (`metadata/upgrade.ts`), so older books still work and
rewrite themselves on the next save.

## Layout

- `parser/` BML → `BmlDocument` tree (pure, `parse(source)`)
- `metadata/` metadata.json → CSS (`generateDomCSS/PagedCSS/FontLinks`);
  `page-setup.ts` resolves the `page` section (page + sheet + signature, spec
  §4.3) into the derived imposition, shared with `web/` and print export
- `renderer/` tree → HTML body (`render(doc, opts)`), `base.css`; two Paged.js
  handlers, imported by `web/src/app.ts`: `plates.js` (full-page illustrations
  as plates, inlined by `toHtml`) and `folios.js` (the page map: folios, TOC and
  ref numbers, running heads)
- `server/` `pipeline.ts` (`buildBook`) + `dev-server.ts` (HTTP/WebSocket,
  watches book files)
- `web/` browser app; `web/src/app.ts` bundles to `web/app.js` (gitignored);
  `web/app.css` is the chrome's stylesheet and holds the Ink tokens. Paged.js
  paginates the preview. The Write/Style/Publish mode (`setMode` in `app.ts`)
  decides three columns in `#panes`: `#tree` | `#editor` | `#preview`,
  `#style-nav` | `#config-overlay` | `#preview`, or `#style-nav` |
  `#config-overlay` | `#sheet-view`; `preview.ts`'s `installPreviewClicks`
  routes a page click to the source line or the style by mode. `config-panel.ts`
  is the panel shell (nav, routing, debounced `queueSave`); `panel-page.ts`
  (Page + Publish views), `panel-fonts.ts`, `panel-parts.ts` (Book parts list
  and detail views) build the views from `panel-controls.ts` primitives;
  `style-catalog.ts` maps preview clicks and book parts to metadata keys. The
  Publish view draws the first signature with `server/imposition.ts` and exports
  through the dev server's `POST /api/books/<book>/export` (the same
  `exportBook` as `bml export`) and `POST /api/books/<book>/epub` (the same
  `exportEpub` as `bml epub`); its Print button (`print.ts`) imposes the live
  preview's pages onto sheet-sized print layers and opens the browser's print
  dialog, no Chrome on the server.

Paged.js 0.4.3 is vendored at `vendor/pagedjs/`; upgrading = replace the file +
update the checksum in `server/vendor_test.ts`, then read the golden page-map
diff and re-check the no-reflow note on `layOut` in `renderer/folios.js`.
`renderer/base.css` lays out centre-plus-side margin rows itself (0.4.3
mismeasures them), keyed on Paged.js's `.pagedjs_margin-*` / `.hasContent`.

## Commands

- `deno task setup` once per checkout: git hooks, `.claude/launch.json` with
  this checkout's port, and in a worktree a `books/` symlink to the main library
- `deno task dev` build client + live server. Main checkout:
  http://localhost:8000; a worktree gets its own stable port (`server/port.ts`;
  `PORT=` overrides). Book edits push live; app, renderer and server edits
  rebuild or restart and the page reloads itself (`architecture` skill →
  `references/dev-workflow.md`)
- `deno task test` all tests (`*_test.ts` next to each module, ~50 s with
  Chrome); `deno task test:fast` skips the Chrome tests (~10 s, what pre-commit
  runs)
- `deno task fonts` regenerate `metadata/fonts-catalog.ts` (every Google family,
  for the font picker) from Google's public catalog
- `deno task bml list` books on disk
- `deno task bml new <slug>` scaffold `books/<slug>/` from
  `templates/metadata.json` (house style)
- `deno task bml check <book>` parse diagnostics as `file:line: msg`; exit 1 on
  any — run after every manuscript edit
- `deno task bml render <book> [out] [--edition e]` standalone HTML (default
  `books/<book>/render.html`, or `render.<e>.html`); open in a browser to
  paginate
- `deno task bml export <book> [--edition e] [--proof] [--sheet S] [--folios N|booklet] [--duplex M]`
  → `books/<book>/export/` (or `export/<e>/`): `book.pdf`, the sheet PDFs and
  `page-map.json` (the settled seed, keyed by a hash of the render's inputs, so
  a re-export of an unchanged book takes one pass); needs Google Chrome
  installed; fails on page-map problems unless `--force`
- `deno task bml epub <book> [--edition e] [--out dir]` → `book.epub` in the
  same export dir; EPUB 3, reflowable, no Chrome needed.
  `brew install
  epubcheck` enables the validator test in
  `server/epub-export_test.ts`
- `deno task bml edition <book> new <slug> [--from e]` copy an edition under a
  new name. Editions are styling-only variants: `metadata.json` is the unnamed
  edition, `editions/<slug>.json` are named ones, manuscript and images shared.

## Adding a book

`deno task bml new <slug>`, put the source text at `books/<slug>/download.txt`,
then the `convert-manuscript` skill (`.claude/skills/`) writes `manuscript.md`.
Style afterwards in the app. Print: `bml export <slug> --proof` first on a new
printer, check one signature by hand, then the real export.

## Skills (`.claude/skills/`)

Read the one that fits before starting: `architecture` (layers, where a change
goes, dev loop, Paged.js quirks), `bookbinding` (folios, signatures, imposition,
furniture rules), `ux-principles` (who it's for, the three-column rule,
click-to-style), `ink-design` (tokens and patterns for the chrome),
`convert-manuscript` (source text → BML).

## Conventions

- Deno only, strict TS, `noUncheckedIndexedAccess`. No new deps without reason.
- Tests are plain `Deno.test` with `jsr:@std/assert`. Fixture book:
  `server/testdata/demo-book`. `testdata/common-sense` and
  `testdata/great-gatsby` are the tracked full-grammar corpus (`books_test.ts`)
  — public domain, kept in sync by hand with `books/` when styling changes.
- CI (`.github/workflows/ci.yml`) runs `check`, `build:web` + `test` on macOS
  (Chrome preinstalled; golden page maps need macOS font rasterisation). Chrome
  tests gate on `hasChrome` from `testing/chrome.ts`, which launches Chrome once
  and skips the tests only if that fails.
- Sample manuscripts start from Project Gutenberg `download.txt` in the book
  dir; strip the Gutenberg header/footer, never leave it in `manuscript.md`.
- Commit messages: `feat:|fix:|test:|style:|chore:` prefix, present tense.
- `docs/` is local scratch (gitignored): specs, plans, todos. Never `git add`
  it; durable knowledge goes in the spec, a code comment or a skill reference.
