# book-editor-app

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
deno task test          # run the suite
deno task dev           # build the client + live server at http://localhost:8000
```

`deno task dev` watches the book's files and pushes changes to the preview over
a WebSocket, so editing the manuscript or the styling updates the page live.

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

`book-renderer-spec.md` is the source of truth for the format; `bml-spec-v06.md`
is the markup language reference.

## Tests

Tests are plain `Deno.test`, living next to the module they cover. Two public
domain books under `testdata/` — Paine's _Common Sense_ and _The Great Gatsby_ —
are the full-grammar regression corpus, so the suite passes on a fresh clone. CI
runs it on every push and pull request.

## License

MIT — see [LICENSE](LICENSE).
