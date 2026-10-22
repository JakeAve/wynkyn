# Wynkyn

A web app for typesetting and printing hand-bound books.

You write a manuscript in **BML** — a small semantic markup language for prose
(chapters, epigraphs, poems, verses, pull quotes, sidebars, drop caps,
footnotes) — and all styling lives in a separate `metadata.json`. The app
renders the book in the browser, paginates it with
[Paged.js](https://pagedjs.org/), and exports a print-ready PDF imposed into
folded signatures for hand binding.

## Requirements

- [Deno](https://deno.com/) 2.x
- Google Chrome — only for `bml export` (PDF rendering)

## Quick start

```sh
deno task setup         # once per checkout: git hooks, dev port, books/ in a worktree
deno task check         # deno fmt --check, lint, and type check
deno task test          # the whole suite (needs Chrome); test:fast skips the browser tests
deno task dev           # build the client + live server at http://localhost:8000
```

`setup` points `core.hooksPath` at `.githooks/`, so `check` and the fast tests
run on every commit and the full suite on every push.

`deno task dev` watches the book's files and pushes changes to the preview over
a WebSocket, so editing the manuscript or the styling updates the page live.
Editing the app itself rebuilds the bundle, restarts the server and reloads the
page. Every git worktree gets its own port (the main checkout 8000, a worktree a
stable one from its folder name; `PORT=` overrides), so several can run side by
side; `books/` is gitignored, so `setup` links a worktree's to the main
checkout's library.

## A book on disk

```
books/<slug>/
  manuscript.md    BML source — semantic markup only, no styling
  metadata.json    trim size, margins, fonts, and every style rule
  images/          illustrations and ornaments
```

`books/` is gitignored; it's a personal library, not part of the project.

## CLI

```sh
deno task bml list                    # books on disk
deno task bml new <slug>              # scaffold books/<slug>/ from templates/ house style
deno task bml check <book>            # parse diagnostics as file:line: msg (exit 1 on any)
deno task bml render <book> [out]     # standalone HTML, default books/<book>/render.html
deno task bml export <book>           # print-ready PDFs into books/<book>/export/
```

`export` takes `--proof` (a single signature to test a new printer), `--sheet`,
`--folios`, and `--duplex`. Run a proof and fold it by hand before committing
paper to a full print.

## Layout

| Path        | What it does                                               |
| ----------- | ---------------------------------------------------------- |
| `parser/`   | BML → `BmlDocument` tree (pure, `parse(source)`)           |
| `metadata/` | `metadata.json` → CSS                                      |
| `renderer/` | tree → HTML body, plus `base.css`                          |
| `server/`   | build pipeline, live dev server, imposition and PDF export |
| `web/`      | the browser app — editor, style panel, paginated preview   |

`book-renderer-spec.md` is the source of truth for the format; its §3 is the
markup language reference.

## Tests

Tests are plain `Deno.test`, living next to the module they cover. Two public
domain books under `testdata/` — Paine's _Common Sense_ and _The Great Gatsby_ —
are the full-grammar regression corpus, so the suite passes on a fresh clone. CI
runs it on every push and pull request.

## License

MIT — see [LICENSE](LICENSE).
