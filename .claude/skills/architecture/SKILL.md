---
name: architecture
description: Use before adding or moving code in Wynkyn — a new module, metadata key, sentinel, panel view, client feature, server route or test — or when deciding where something belongs and what may import what. Also use for the web app's modules, modes and saving (sync.ts, backend.ts), the spec version in metadata.json, the hosted site and its deploys (build:site, dist/, Deno Deploy, GitHub Pages), the dev loop (git worktrees, ports, hot reload, test tiers, fixtures, CI, verifying in Chrome), writing or fixing a test, a red or flaky CI run, and whenever Paged.js does something surprising in the preview or export or needs upgrading. Read it even for a "small" change that crosses a directory boundary.
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

- `parser/` and `metadata/` know nothing about files or the DOM. `parser/` is
  BML → `BmlDocument` tree (`parse(source)`); `metadata/` is metadata.json →
  CSS (`generateDomCSS/PagedCSS/FontLinks`), and also holds `page-setup.ts`,
  the one place page + sheet + signature geometry is resolved (the panel and
  the exporter both call it so they can't disagree), and `themes.ts`, the preset themes (`THEMES`, `applyTheme`: what a theme
  owns, spec §4.13) shared by `bml new`, the dev server and the browser.
- `renderer/` is tree → HTML body (`render(doc, opts)`) plus `base.css` and
  two classic scripts that run inside Paged.js as handlers: `plates.js`
  (full-page illustrations as plates) and `folios.js` (the page map: folios,
  TOC and ref numbers, running heads). `toHtml` inlines them, `web/src/app.ts`
  imports them, and Deno imports them for tests.
- `server/` owns every side effect, behind one seam: `store.ts`'s `BookStore`
  is the only way book files are read or written (`diskStore` here,
  `web/src/fs-store.ts` in the browser, a Node store for the desktop app
  later); every store reports every change through `watch`, its own writes
  included; `withTabs` shares a library's changes between tabs over a
  BroadcastChannel; and `store-contract.ts` is what each must pass
  (`testing/memory-store.ts` is the in-memory one). Saves are in the service (it
  answers after the write) and `web/src/sync.ts` (the client's queues, retry,
  "Saved"). `pipeline.ts` (`buildBook`) and `book-service.ts` (`BookService`:
  everything an editor does to a library) are pure over a store and run in
  the browser too. Front doors: `dev-server.ts` (HTTP/WebSocket over
  `books/`, plus the Chrome exports), `bml.ts` (CLI), and
  `web/src/backend.ts`'s `localBackend` (the service in-page). `export-html.ts`,
  `print-export.ts`, `pdf.ts`, `epub-export.ts`, `local-fonts.ts` are Deno
  only and never imported by `web/`.
- `web/` bundles to the browser. It may import from `server/` only what is pure
  at load: `imposition.ts`, `editions.ts`, `images.ts`, `store.ts`,
  `pipeline.ts`, `book-service.ts`, `import/` and their types. A `Deno.*`
  reference inside a function body bundles fine (it is never called in the browser); one at the top level
  breaks the bundle, so if the browser needs a helper that lives beside I/O,
  move the helper, never the I/O. The app reaches the server only through
  `backend.ts`; `app.ts` never calls `fetch` for book data itself.

Chrome-driven tests under `renderer/` and `server/` may import
`server/pipeline.ts`, `testing/chrome.ts` and `testing/wait.ts`; production code in `renderer/`
never imports from `server/`.

## Where a change goes

| Change | Touch, in this order |
| --- | --- |
| New metadata key | `metadata/types.ts` → `css-generator.ts` + its test → spec §4 → `templates/metadata.json` if it has a house default → `web/src/style-catalog.ts` if it's clickable or listed → a control in `panel-*.ts` → `metadata/upgrade.ts` only if an old key is renamed; a spec version bump moves `SPEC_VERSION`, the template's `spec` and the spec's §3 heading together (`upgrade_test.ts`) |
| New sentinel | spec §3 → `parser/` → `renderer/render.ts` → `base.css` → `style-catalog.ts` → `web/src/snippets.ts` for the editor's insert menu |
| New server endpoint | a method on `BookService` (over the store, throwing `ServiceError` with the status); `dev-server.ts` routes to it; `web/src/backend.ts` gets it on `Backend` for both `httpBackend` and `localBackend`; `bml.ts` gets the same function if it makes sense on the CLI |
| Anything that reads or writes a book file | through the `BookStore` only, never `Deno.*` — or it stops working in the browser and the desktop app |
| New panel view | build from `panel-controls.ts` primitives into `panel-page.ts`, `panel-fonts.ts`, `panel-parts.ts`, `panel-furniture.ts` or `panel-themes.ts` (the Theme view's cards); `config-panel.ts` only routes and saves; a view that changes the preview without saving (the theme preview) asks through a panel option, which `app.ts` hands to the module that owns it (`theme-preview.ts`) |
| Anything a page click should reach | `style-catalog.ts` maps the rendered class to the metadata path; `preview.ts` is only the DOM adapter |
| New client feature (a dialog, a menu, a toolbar job) | its own module in `web/src/` exporting one `install…(deps)`, or a class if it holds state; `app.ts` gets one call to it and nothing else (see The web app) |
| Pagination behaviour (folios, heads, TOC numbers, blanks) | `renderer/folios.js`, then read the golden page-map diff (`UPDATE_GOLDEN=1 deno task test`) before accepting it |

Front doors stay thin: logic a route or a click handler computes goes in a
pure sibling with a test. `dev-server.ts` is the HTTP surface and only routes;
`app.ts` is wiring and modes only.

## The web app

`references/web-app.md` maps the modules; these are the rules.

- `app.ts` wires the modules and owns the mode (`setMode`) — nothing else. A
  new client job is its own module in `web/src/` exporting one
  `install…(deps)`, or a class when it holds state (`ThemePreview`). Its deps
  are getters for state that changes (`book()`, `edition()`, `backend()`,
  `sync()`) — a plain value only for what is fixed for the page's life — and
  callbacks into the app (`leave`, `setStatus`). Never grow `app.ts` with it.
- Nothing imports `app.ts`. Shared DOM helpers (`$`, `brief`) are in `dom.ts`;
  a helper two modules need moves to a sibling, never into `app.ts`.
- Save state lives only in `sync.ts`: its queues, retry, and `status()`, the
  one place "Saved" is decided. Book data only through `backend.ts` (never a
  `fetch`). Every page switch goes through `leave(href)`, which flushes Sync
  and asks before dropping an unsaved edit.
- Logic a handler computes goes in a pure sibling with a test
  (`tree-data.ts`, `editions.ts`, `style-catalog.ts`, `sync.ts`), not in the
  DOM module.

## Standing rules

- Deno only, strict TS, `noUncheckedIndexedAccess`; no new dependency without
  a reason the existing ones can't meet.
- Tests are plain `Deno.test` beside the module. One test that fails when the
  logic breaks beats a suite per function. Chrome tests gate on `hasChrome`;
  pagination truth is the golden page maps under `testdata/`. Tests wait for
  the state they assert, never a clock: `testing/wait.ts`, enforced by
  `testing/clock_test.ts`. Read references/dev-workflow.md, "What earns a
  test" and "Tests that hold on CI", before writing a test or touching a
  failing one.
- `metadata.json` carries a top-level `spec`, the spec version it complies
  with. `SPEC_VERSION` in `metadata/upgrade.ts` is the source of truth;
  `templates/metadata.json` and the spec's §3 heading must match it
  (`upgrade_test.ts` checks). The loader stamps it on files without one; the
  app warns on a book newer than itself. A version bump moves all three
  together.
- `docs/` is local scratch and gitignored. Durable knowledge goes in the spec,
  a code comment, or a skill reference — never a committed doc.
- Every chrome color, size and face is a token in `web/tokens.css`, named in
  `design-language.md`; see the `rubric-design` skill.

## Paged.js

Paged.js 0.4.3 is vendored at `vendor/pagedjs/`. Upgrading = replace the file
and update the checksum in `server/vendor_test.ts`, then read the golden
page-map diff and re-check the no-reflow note on `layOut` in
`renderer/folios.js`. `renderer/base.css` lays out centre-plus-side margin rows
itself (0.4.3 mismeasures them), keyed on Paged.js's `.pagedjs_margin-*` /
`.hasContent`; re-check that after an upgrade too. The export lays segments
out alone and assembles them (`BookPageMap.assemble`, redoing classes and margin
boxes as Paged.js would), so an upgrade also re-runs
`server/segments-browser_test.ts`: assembled pages must still match a whole-flow
render page for page. Its known traps are the three references below.

## Read next

- `references/web-app.md` — the client modules, the backends, the three
  columns per mode, the panel views, the Publish view.
- `references/hosted-site.md` — `build:site`, `dist/`, the static host
  deploys, what runs in the browser there.
- `references/dev-workflow.md` — worktrees and ports, what hot-reloads and
  what doesn't, the two test tiers, fixtures, CI, how to verify a layout
  change in real Chrome.
- `references/pagedjs-plus-combinator.md` — Paged.js drops every rule with a
  `+` combinator; what to write instead.
- `references/pagedjs-justify-leak.md` — the split-paragraph justification
  leak and the `base.css` guard for it.
- `references/pagedjs-breaks.md` — `page` and `break-*` go by source order,
  not specificity, and their selectors split on every comma.
- Spec §5 (module contracts) and §6 (web architecture) for the why.
