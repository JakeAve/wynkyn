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
| `web/index.html`, `web/tokens.css`, `web/app.css`, `renderer/*` (incl. `base.css`, `plates.js`, `folios.js`), `vendor/` | server restart, client reload — the server reads these once at startup, which is why a plain restart used to be needed |
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

### Tests that hold on CI

CI's macOS runners are slower than a laptop, and unevenly so: a step that
takes 40 ms here took 45 s there. A test that reads the page at a guessed
moment passes here for months and then fails on `main`. Every rule below
comes from a real red run.

**1. Pick the cheapest test that can fail.** Logic goes in a pure function
with a plain `Deno.test` (no browser, no server, no clock). A Chrome test is
only for what only a browser knows: real layout and pagination, a click, a
key, focus, a transition. Several assertions about one flow go in one
Chrome test, not one test each.

**2. Wait for the state you assert, never for time.** Use `testing/wait.ts`:

| Helper | Waits for |
| --- | --- |
| `laidOut(page, after?)` | the preview laid out with nothing pending (no render, no edit waiting for one), and the page turns and indicator caught up. Pass the count from before an edit to wait for the layout after it |
| `eventually(check)` | an assert to hold, retried like Playwright Test's `expect`. Wrap any read of state an action changes later: `assertEquals(await x.count(), 0)` alone reads once, at whatever instant |
| `until(ok, what)` | a condition, polled |
| `quietFor(ms)` | nothing: the pause before asserting that something did *not* happen |

Their deadlines are 30 s or more, long enough that only a hang reaches them.
Playwright's own locator waits (`locator.waitFor()`) are fine too.
`testing/clock_test.ts` fails any `setTimeout` or `waitForTimeout` in a test
without a `// clock: <why>` on its line or the one above. The reason must
hold on a runner ten times slower: "slowness only makes this pass more
easily" (no second push arrives), or "there is nothing to wait on" (a fresh
FSEvents watch has no ready signal).

Reading straight after a synchronous action is fine: a key pressed into
CodeMirror has changed the document when `press` returns. Anything that goes
through a save, the server, the watch, the websocket, a render, a debounce,
a transition or an animation frame needs a wait.

**3. If the app gives no signal for the state, add one to the app.** An
attribute or a count, as `afterLayout` in `app.ts` counts layouts on
`#preview[data-layouts]`, beats inferring the state from what is on screen.

**4. Know the false signals.** Each passed locally and failed on CI:

- **An earlier sign of the state:** page 2 in the preview is not "the layout
  is done". Paged.js draws page by page, and the page turns land only with
  the last page. Nor is "the page count held for 300 ms", nor
  `.preview-stage` detached: the stage is also absent before a render starts.
  All three are `laidOut`.
- **A budget in steps:** "40 tries × 50 ms" is a 2 s clock in disguise.
  Bound a poll by a deadline.
- **A transition or fade:** wait for its class or attribute to land, then
  `Promise.all(el.getAnimations().map((a) => a.finished))`. Read straight
  after the class lands and the value is still the start of it.
- **Something that goes on the next frame** (⌥ released, a hover left): read
  what you need *before* the action that clears it.
- **A push or a save:** match the one you caused (`nextMessageWhere` on its
  version), not merely the next. A write truncates first, so the watch can
  push a half-written file ahead of it.
- **"Nothing arrives":** a late watch event can push a rebuild of unchanged
  content at any time. Listen for the thing that must not arrive (the other
  edition's styles), not for any message.
- **Counting events:** count the ones your action caused, by version, not
  "all since I reset the counter after a pause".
- **A CodeMirror line:** it is drawn only near the viewport. Scroll less than
  a screen at a time and wait two `requestAnimationFrame`s after each step.

**5. Prove it before you push.** Run a new or changed Chrome test five times
(`for i in 1 2 3 4 5; do deno test -A <file> --filter "<name>"; done`). For
a wait on a transition, stretch the app's `--t` and `--t-fast` to 1 s: the
old wait should fail and the new one pass. Forcing `transition-duration` on
`*` animates everything and proves nothing. CPU throttling
(`Emulation.setCPUThrottlingRate`) slows the test as much as the app, so it
rarely opens a race. Log what the test sees at the moment it starts waiting
(here, "0 page turns at page 2") instead. Don't judge a flake while another
worktree's suite is running: two suites and two Chromes starve each other.

**6. A red CI run that passed on the PR is a race, not bad luck.** Never
re-run it to green, add retries or raise a timeout. Read the failing line,
find what the test waited on instead of the state it asserts, fix that, and
check the rest of the file for the same pattern. CI tests a PR merged with
the latest `main`, so the clock guard can fail on a sleep another branch
brought in: fix it there too.

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
