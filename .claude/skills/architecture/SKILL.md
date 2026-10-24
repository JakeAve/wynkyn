---
name: architecture
description: Use before adding or moving code in Wynkyn — a new module, metadata key, sentinel, panel view, server route or test — or when deciding where something belongs and what may import what. Also use for the dev loop (git worktrees, ports, hot reload, test tiers, verifying in Chrome) and whenever Paged.js does something surprising in the preview or export. Read it even for a "small" change that crosses a directory boundary.
---

# Architecture

One pipeline, two consumers: `parse → render → css` runs the same way for the
live preview and for `bml export`/`bml epub`. `book-renderer-spec.md` is the
contract; when code and spec disagree, ask rather than pick.

## Layers: import only downward

```
parser/  →  metadata/  →  renderer/  →  server/  →  web/
pure        pure          pure+2 js     disk, Chrome   browser only
```

- `parser/` and `metadata/` know nothing about files or the DOM. `metadata/`
  also holds `page-setup.ts`, the one place page + sheet + signature geometry is
  resolved (the panel and the exporter both call it so they can't disagree),
  and `themes.ts`, the preset themes (`THEMES`, `applyTheme`: what a theme
  owns, spec §4.13) shared by `bml new`, the dev server and the browser.
- `renderer/` is tree → HTML plus `base.css` and two classic scripts,
  `plates.js` and `folios.js`, that run inside Paged.js. The server inlines
  them; Deno imports them for tests.
- `server/` owns every side effect, behind one seam: `store.ts`'s `BookStore`
  is the only way book files are read or written (`diskStore` here,
  `web/src/fs-store.ts` in the browser, a Node store for the desktop app
  later). `pipeline.ts` (`buildBook`) and `book-service.ts` (`BookService`:
  everything an editor does to a library) are pure over a store and run in
  the browser too. Front doors: `dev-server.ts` (HTTP/WebSocket over
  `books/`, plus the Chrome exports), `bml.ts` (CLI), and
  `web/src/backend.ts`'s `localBackend` (the service in-page). `export-html.ts`,
  `print-export.ts`, `pdf.ts`, `epub-export.ts`, `local-fonts.ts` are Deno
  only and never imported by `web/`.
- `web/` bundles to the browser. It may import from `server/` only what is pure
  at load: `imposition.ts`, `editions.ts`, `store.ts`, `pipeline.ts`,
  `book-service.ts` and their types. A `Deno.*` reference inside a function
  body bundles fine (it is never called in the browser); one at the top level
  breaks the bundle, so if the browser needs a helper that lives beside I/O,
  move the helper, never the I/O. The app reaches the server only through
  `backend.ts`; `app.ts` never calls `fetch` for book data itself.

Chrome-driven tests under `renderer/` and `server/` may import
`server/pipeline.ts` and `testing/chrome.ts`; production code in `renderer/`
never imports from `server/`.

## Where a change goes

| Change | Touch, in this order |
| --- | --- |
| New metadata key | `metadata/types.ts` → `css-generator.ts` + its test → spec §4 → `templates/metadata.json` if it has a house default → `web/src/style-catalog.ts` if it's clickable or listed → a control in `panel-*.ts` → `metadata/upgrade.ts` only if an old key is renamed |
| New sentinel | spec §3 → `parser/` → `renderer/render.ts` → `base.css` → `style-catalog.ts` → `web/src/snippets.ts` for the editor's insert menu |
| New server endpoint | a method on `BookService` (over the store, throwing `ServiceError` with the status); `dev-server.ts` routes to it; `web/src/backend.ts` gets it on `Backend` for both `httpBackend` and `localBackend`; `bml.ts` gets the same function if it makes sense on the CLI |
| Anything that reads or writes a book file | through the `BookStore` only, never `Deno.*` — or it stops working in the browser and the desktop app |
| New panel view | build from `panel-controls.ts` primitives into `panel-page.ts`, `panel-fonts.ts`, `panel-parts.ts`, `panel-furniture.ts` or `panel-themes.ts` (the Theme view's cards); `config-panel.ts` only routes and saves; a view that changes the preview without saving (the theme preview) asks `app.ts` through a panel option |
| Anything a page click should reach | `style-catalog.ts` maps the rendered class to the metadata path; `preview.ts` is only the DOM adapter |
| Pagination behaviour (folios, heads, TOC numbers, blanks) | `renderer/folios.js`, then read the golden page-map diff (`UPDATE_GOLDEN=1 deno task test`) before accepting it |

Big files are fine when they are one thing: `app.ts` is the client
orchestrator, `dev-server.ts` the HTTP surface. The smell to watch for is logic
in a front door — a route or a click handler that computes something — when it
belongs in a pure sibling with a test.

## Standing rules

- Deno only, strict TS, `noUncheckedIndexedAccess`; no new dependency without
  a reason the existing ones can't meet.
- Tests are plain `Deno.test` beside the module. One test that fails when the
  logic breaks beats a suite per function. Chrome tests gate on `hasChrome`;
  pagination truth is the golden page maps under `testdata/`.
- `docs/` is local scratch and gitignored. Durable knowledge goes in the spec,
  a code comment, or a skill reference — never a committed doc.
- Every chrome colour is a token in `web/app.css`; see the `ink-design` skill.

## Read next

- `references/dev-workflow.md` — worktrees and ports, what hot-reloads and
  what doesn't, the two test tiers, how to verify a layout change in real
  Chrome.
- `references/pagedjs-plus-combinator.md` — Paged.js drops every rule with a
  `+` combinator; what to write instead.
- `references/pagedjs-justify-leak.md` — the split-paragraph justification
  leak and the `base.css` guard for it.
- Spec §5 (module contracts) and §6 (web architecture) for the why.
