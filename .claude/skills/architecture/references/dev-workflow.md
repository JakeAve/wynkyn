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

| Command | Runs | When |
| --- | --- | --- |
| `deno test -A <file>` | the files you touched | the inner loop: this is what you run |
| `deno task test:fast` | everything without Chrome (`SKIP_CHROME=1`), ~10 s | pre-commit hook; CI's Ubuntu `fast` job |
| `deno task test` | all, Chrome included, ~2.5 min | CI's macOS `test` job, the gate |

CI is the only place the whole Chrome suite runs. Don't run it locally to
"make sure", and never while another worktree's suite is running: suites in
several worktrees starve each other of CPU, which is how a passing test
times out and a session spends an hour on a race that isn't one. Run the
files you changed, push, and read CI. The Chrome tests are the ones that know
whether a page actually moved, so a pagination or CSS change runs its Chrome
files before pushing. `UPDATE_GOLDEN=1 deno test -A server/pagination_test.ts`
rewrites `testdata/*/page-map.json`; read the diff, it is the change.

The pre-commit hook gives up after 120 s and exits 142. The fast tier takes
~10 s, so that is a stalled test, not a slow machine: find it rather than
raise the limit.

Tests are `*_test.ts` beside each module. `web/src/local-browser_test.ts`
drives the built `dist/` with no server, so `deno task build:site` first or it
is skipped.

### The Chrome harness

A Chrome test costs a page, never a browser or a server:

- `testing/chrome.ts` launches one Chrome per test process and keeps it.
  `chromeTest({ name, fn })` is `Deno.test` on it (sanitizers off, since the
  browser outlives a test); `newPage(opts?)` is a page in a fresh context, so
  storage never leaks between tests, closed when the test ends.
- `testing/app.ts` runs one dev server per test process over a library in
  memory. `appTest` is `chromeTest` that also needs `web/app.js`. `book({
  manuscript?, metadata? })` seeds the demo book under a fresh slug;
  `openApp(b)` is a laid-out page on it. `b.write(name, data)` is an outside
  edit the server hears synchronously; `b.read(name)` is what landed.
- No FSEvents in an app test: a disk watch can push late or twice, the root
  of most of this repo's flakes. Only `server/live-sync-browser_test.ts` and
  the store contract are about the disk.
- A test that needs the library to itself starts its own
  `startServer({ store: memoryStore(), port: 0 })` but still takes its pages
  from the shared Chrome.
- The suite runs serially. `--parallel` (worker threads) and one process per
  core both hung a first `newContext` now and then; parallel runs come back
  only with a reason that outweighs a flake. A test still never writes a
  tracked file or a fixed path: temp dirs and seeded books only.
- A tracked corpus book (`testdata/`) is laid out once per variant per run and
  every assertion reads that layout; it is seconds a time on CI.

### What earns a test

A test is worth what it catches that nothing else does. Every one is code to
keep green, and every Chrome test is also a race in waiting: nearly every red
run on `main` has been a Chrome test reading the page at the wrong moment, and
CI spends most of its ~8 minutes in them. Before writing a test, name the bug
it would catch and check no test already catches it.

- **One test per behaviour, at the lowest layer that sees it.** Logic goes in
  a pure function with a plain `Deno.test` (no browser, no server, no clock).
  A Chrome test is only for what only a browser knows: real layout and
  pagination, a click, a key, focus, a transition. It doesn't re-prove
  through the UI what a pure test proves; it proves the wiring.
- **Extend a flow before starting one.** Each Chrome test boots a server, a
  browser and a book, seconds on CI. A new assertion in the test that already
  opens that screen costs nothing. Several assertions about one flow go in
  one test, not one test each.
- **The goldens are pagination's test.** A page count or where a heading lands
  shows in the `testdata/*/page-map.json` diff; don't add a Chrome test for it.
- **Test behaviour, not text.** Don't pin copy, a table's rows verbatim, CSS
  text, a constant, or a one-line wrapper (`return info.name`). Those tests
  fail on every deliberate change and never on a bug.
- **Not every fix needs its own test.** Add one where the same logic could
  break the same way again. A typo, a wrong constant or a one-line wiring fix
  is covered by the flow test that already walks it, or by nothing.
- **Same shape, one table.** Near-identical cases are rows of one `Deno.test`.
- **Fixing a flake starts with "should this test exist?"** If another test
  already covers it, deleting it is the root fix.

### Tests that hold on CI

CI's macOS runners are slower than a laptop, and unevenly so: a step that
takes 40 ms here took 45 s there. A test that reads the page at a guessed
moment passes here for months and then fails on `main`. Every rule below
comes from a real red run.

**1. Pick the cheapest test that can fail** (What earns a test, above).

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

**5. Prove a race fix, not every test.** A new Chrome test runs once,
locally, and then on CI. A fix for a flake has to show that it fails the old
way and passes the new: for a wait on a transition, stretch the app's `--t`
and `--t-fast` to 1 s; the old wait should fail and the new one pass.
Forcing `transition-duration` on `*` animates everything and proves nothing.
CPU throttling (`Emulation.setCPUThrottlingRate`) slows the test as much as
the app, so it rarely opens a race. Log what the test sees at the moment it
starts waiting (here, "0 page turns at page 2") instead. Repeated runs prove
little on a laptop that is faster than CI, and nothing at all while another
suite shares the CPU.

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

`.github/workflows/ci.yml` has two jobs. `fast` (Ubuntu) runs `check` and
`test:fast`, so a lint or unit failure comes back in about a minute. `test`
(macOS) runs `build:site` and the full suite: Chrome is preinstalled there,
and the golden page maps need macOS font rasterisation. The `main` ruleset
requires the check named `test`; renaming that job blocks every merge.

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

`server/pagination_test.ts` and `renderer/folios-browser_test.ts` show how;
copy from them rather than from memory.
