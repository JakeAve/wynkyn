# The web app

`web/` is the browser app. `web/src/app.ts` bundles to `web/app.js`
(gitignored, built per checkout); `web/index.html` holds the DOM;
`web/app.css` is the chrome's stylesheet; its tokens live in `web/tokens.css`
(`rubric-design` skill, `design-language.md`). Paged.js paginates the preview. The rules for adding to
it are in `SKILL.md`, The web app; this is the map.

## Wiring

`app.ts` wires the modules below and owns the mode. One job each beside it:

| Module | Job |
| --- | --- |
| `library.ts` | `connect()`: the dev server, or with none the folder / browser-storage choice (remembered in localStorage `library`) |
| `switcher.ts` | `installSwitcher`: the crumb (Book / Edition · size) and the book/edition switcher — search, Rename, Delete, New edition, download as zip, Change library |
| `create-book.ts` | `installCreateBook`: Create a new manuscript (import a file or web page, copy in from a folder, start blank), the title and web dialogs; `renderImportNotes` for the footer's import notes |
| `theme-preview.ts` | `ThemePreview`: try a theme with nothing saved, hold pushed builds meanwhile, Apply |
| `text-view.ts` | `installTextView`: the editor's font, size, Hide markup and spell check (a reader preference, localStorage, not the book) |
| `dom.ts` | `$`, `brief` — the helpers every module shares |

Editor side: `editor.ts` (the CodeMirror pane), `bml-language.ts`,
`editor-insert.ts` + `snippets.ts` (inserting sentinels), `editor-images.ts`
(dropped/pasted images), `search-panel.ts`, `spelling.ts`, `diagnostics.ts`.
Outline: `tree-data.ts` (pure) → `tree-view.ts`. Storage in the page:
`fs-store.ts`, `book-zip.ts`, `preview-cache.ts` (one cached render per book +
edition in IndexedDB), `web-source.ts` (a web page as an import source).

## Talking to the book

- `backend.ts` is what the app talks to, and it never knows which it has:
  `httpBackend` (the dev server, HTTP plus a WebSocket for pushed rebuilds) or
  `localBackend` (the same `BookService` run in the page over the author's own
  folder via the File System Access API, or the browser's private storage).
  The hosted site has no server at all (`references/hosted-site.md`).
- `sync.ts` is the client's save state machine for one book and edition: the
  manuscript and metadata queues, debounce, one save in flight per channel,
  retry with backoff, the versions the buffer and panel are based on, the
  conflict hand-off, and `status()`, the one place Saved / Saving / Not saved
  is decided (spec §6). No DOM; `app.ts` adapts it to the toolbar and banners.
- `leave(href)` in `app.ts` is every page switch: it flushes Sync and asks
  before dropping an unsaved edit. Modules get it as a dep.

## Modes and columns

The Write/Style/Publish mode (`setMode` in `app.ts`, persisted) decides the
three columns in `#panes`:

| Mode | Left | Middle | Right |
| --- | --- | --- | --- |
| Write | `#tree` | `#editor` | `#preview` |
| Style | `#style-nav` | `#config-overlay` | `#preview` |
| Publish | `#style-nav` | `#config-overlay` | `#sheet-view` |

`preview.ts`'s `installPreviewClicks` routes a page click to the source line
(Write) or the style (Style), by mode. `style-catalog.ts` maps preview clicks
and book parts to metadata keys; `preview.ts` is only the DOM adapter.

## The style panel

`config-panel.ts` is the panel shell: nav, routing, and `queueSave`, which
hands each edited section to Sync's debounce. The views are built from
`panel-controls.ts` primitives (pure form maths in `config-data.ts`):
`panel-page.ts` (Page and Publish views), `panel-fonts.ts` (with
`font-picker.ts`, `fonts-list.ts`), `panel-parts.ts` (Book parts list and
detail views), `panel-furniture.ts` (page numbers and running heads),
`panel-themes.ts` (the Theme view's cards).

The Publish view is grouped Binding / PDF / E-book:

- **Binding** — the binding setup, whose first signature it draws with
  `server/imposition.ts`, and its Print sheets button (`print.ts`), which
  imposes the live preview's pages onto sheet-sized print layers and opens the
  browser's print dialog.
- **PDF** — Print pages: the preview's pages at the page size.
- **E-book** — Export EPUB (`POST /api/books/<book>/epub`, the same
  `exportEpub` as `bml epub`; in-page on the hosted site).

No print export runs on the server; sheet PDFs and proofs on disk are
`bml export`'s.

## History

A preview click into Style leaves no history entry; two jumps push one so
Back returns: Write's footer Go to style (`goToStyle`, back to the line the
writer left) and Paper's "Change in Style" in Publish (`toStyle`, back to
Publish). `installHistory` restores mode, view and line on Back/Forward.
