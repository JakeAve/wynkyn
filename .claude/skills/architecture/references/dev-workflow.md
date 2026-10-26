# Dev workflow

## Worktrees and ports

Each checkout runs its own dev server on its own port, so worktrees never
collide. `server/port.ts` decides: the main checkout (its `.git` is a
directory) takes 8000; a linked worktree (its `.git` is a file) takes a stable
port in 8001–8999 hashed from its folder name; `PORT=… deno task dev` overrides
either.

First thing in a fresh worktree:

```bash
deno task setup
```

It wires the git hooks (shared by every worktree), writes
`.claude/launch.json` with this checkout's port so the desktop app's preview
(`preview_start {name: "dev"}`) lands on the right server, and symlinks
`books/` to the main checkout's library — `books/` is gitignored, so a worktree
starts without one. The dev server says so if you forget. `launch.json` is
generated and gitignored; don't hand-edit it.

`web/app.js` is built per checkout by `deno task dev`, so a worktree's bundle
never leaks into main.

## What hot-reloads

`deno task dev` builds the client once, then runs two watchers side by side:

| You change | What happens |
| --- | --- |
| `books/<slug>/manuscript.md`, `metadata.json`, `editions/*.json`, images | the server rebuilds and pushes over the WebSocket; the preview re-paginates in place, no page reload |
| `web/src/*.ts` | `deno bundle --watch` rewrites `web/app.js`; the server restarts on that; every open client reloads itself once the server is back |
| `web/index.html`, `web/app.css`, `renderer/*` (incl. `base.css`, `plates.js`, `folios.js`), `vendor/` | server restart, client reload — the server reads these once at startup, which is why a plain restart used to be needed |
| `server/*.ts`, `metadata/*.ts`, `parser/*.ts` | `deno run --watch` restarts the server; clients reload |
| `deno.json` import map | stop and rerun `deno task dev` |

A client with an unsaved edit does not reload itself; its status says
"Server restarted — reload to reconnect" so the edit isn't lost.

## Test tiers

| Command | Runs | Time | When |
| --- | --- | --- | --- |
| `deno task test:fast` | everything except the Chrome-driven tests (`SKIP_CHROME=1` makes `hasChrome` false) | ~10 s | pre-commit hook, inner loop |
| `deno task test` | all, including pagination goldens, print export, live sync in a real browser | ~50 s | pre-push hook, CI, after any layout change |

`deno task check` (fmt, lint, types) runs in both hooks. The Chrome tests
are the ones that know whether a page actually moved, so never finish a
pagination or CSS change on the fast tier alone. `UPDATE_GOLDEN=1 deno task
test` rewrites `testdata/*/page-map.json`; read the diff, it is the change.

Tests are `*_test.ts` beside each module. `web/src/local-browser_test.ts`
drives the built `dist/` with no server, so `deno task build:site` first or it
is skipped. Chrome tests gate on `hasChrome` from `testing/chrome.ts`, which
launches Chrome once and skips them only if that fails.

## Fixtures

- `server/testdata/demo-book` — the fixture book most tests build.
- `testdata/common-sense` and `testdata/great-gatsby` — the tracked
  full-grammar corpus (`books_test.ts`), with their golden page maps. Public
  domain, kept in sync by hand with `books/` when their styling changes.

## CI

`.github/workflows/ci.yml` runs `check`, `build:web` and `test` on macOS:
Chrome is preinstalled there, and the golden page maps need macOS font
rasterisation.

## Verifying a layout change for real

Reasoning from CSS is not verification, and the static `render.html` isn't
either (images don't load there). Paginate the book in Chrome and look:

1. `buildBook(root, book, { imageUrlPrefix: "file://…/images", edition })`,
   write `toHtml(...)` to a file.
2. Playwright `chromium.launch({ channel: "chrome" })`, open the file, wait for
   `html[data-paged=done]`.
3. Screenshot the pages involved before and after. When measuring how full a
   page is, measure the last text node — Paged.js's page wrapper is always
   page-tall.

`server/pagination_test.ts` and `renderer/folios-browser_test.ts` show the
harness; copy from them rather than from memory.
