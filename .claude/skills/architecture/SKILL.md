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
  resolved (the panel and the exporter both call it so they can't disagree).
- `renderer/` is tree → HTML plus `base.css` and two classic scripts,
  `plates.js` and `folios.js`, that run inside Paged.js. The server inlines
  them; Deno imports them for tests.
- `server/` owns every side effect: reading books, watching, HTTP/WebSocket,
  Chrome, PDF. `pipeline.ts` (`buildBook`) is the shared entry; `dev-server.ts`
  and `bml.ts` are two front doors to the same functions.
- `web/` bundles to the browser. It may import from `server/` only what is pure
  at load: `imposition.ts`, the helpers in `editions.ts`, and *types* from
  `pipeline.ts`. A module that touches `Deno.*` at the top level breaks the
  bundle, so if the browser needs a helper that lives beside I/O, move the
  helper, never the I/O.

Chrome-driven tests under `renderer/` and `server/` may import
`server/pipeline.ts` and `testing/chrome.ts`; production code in `renderer/`
never imports from `server/`.

## Where a change goes

| Change | Touch, in this order |
| --- | --- |
| New metadata key | `metadata/types.ts` → `css-generator.ts` + its test → spec §4 → `templates/metadata.json` if it has a house default → `web/src/style-catalog.ts` if it's clickable or listed → a control in `panel-*.ts` → `metadata/upgrade.ts` only if an old key is renamed |
| New sentinel | spec §3 → `parser/` → `renderer/render.ts` → `base.css` → `style-catalog.ts` → `web/src/snippets.ts` for the editor's insert menu |
| New server endpoint | logic in a `server/` sibling module exported as a plain function; `dev-server.ts` routes to it; `bml.ts` gets the same function if it makes sense on the CLI |
| New panel view | build from `panel-controls.ts` primitives into `panel-page.ts`, `panel-fonts.ts`, `panel-parts.ts` or `panel-furniture.ts`; `config-panel.ts` only routes and saves |
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
