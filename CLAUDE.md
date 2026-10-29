# Wynkyn

Web app for editing and printing hand-bound books. A book is `books/<slug>/`
with `manuscript.md` (BML — semantic markup, spec §3), `metadata.json` (all
styling, spec §4), and `images/`. `books/` is gitignored.

`book-renderer-spec.md` is the source of truth; when code and spec disagree,
ask. `design-language.md` is the source of truth for how the app and the site
look; when code and it disagree, ask.

## How work happens

- Every change starts in a worktree on its own branch, even a one-line fix, and
  before the first edit. Get the main checkout current first — it may sit on an
  old merged branch with a stale `CLAUDE.md`:
  `git checkout main && git pull origin main`. Then
  `git worktree add .worktrees/<name> -b feat/<name> origin/main` (or `fix/`,
  `chore/`; the branch must not already exist) and `deno task setup` there.
  Work, commit and push from inside the worktree.
- Never edit or commit on `main` in the main checkout; `main` only moves by
  merging a branch. Once merged, delete both:
  `git worktree remove .worktrees/<name> && git branch -d feat/<name>`.
- Edits made in the wrong checkout move with a tagged stash, never a bare one
  (the stash stack is shared across worktrees): `git stash push -u -m <tag>`,
  `git stash apply <sha>` in the worktree, then `git stash drop` it.
- A visible change to the chrome or the site updates `design-language.md` in the
  same diff (`rubric-design` skill).
- Commit messages: `feat:|fix:|test:|style:|chore:` prefix, present tense.
- `docs/` is local scratch (gitignored): specs, plans, todos. Never `git add`
  it; durable knowledge goes in the spec, a code comment or a skill reference.
- Deno only, strict TS, `noUncheckedIndexedAccess`. No new deps without reason.
  Tests are plain `Deno.test` with `jsr:@std/assert`, in `*_test.ts` beside the
  module.
- Comments say why: a constraint, a browser quirk, a spec §, a trade-off.
  Default to none. Never restate the name below, narrate history, or describe
  the change; don't match a neighbour's density. Say nothing or less.
- Tests wait for the state they assert, never a guessed number of milliseconds
  (`testing/wait.ts`: `laidOut`, `eventually`, `until`; `testing/clock_test.ts`
  fails an unlabelled sleep). A CI failure that passes on re-run is a race to
  fix at its root, never a re-run, retry or longer timeout (`architecture` →
  `references/dev-workflow.md`).

## Commands

- `deno task setup` once per checkout: git hooks, dev port, `books/` symlink
- `deno task dev` build the client + live server (main checkout :8000, a
  worktree its own port); edits reload themselves
- `deno task check` fmt, lint, types (both git hooks run it)
- `deno task test` all tests, Chrome included (~50 s, pre-push)
- `deno task test:fast` without Chrome (~10 s, pre-commit)
- `deno task build:site` the hosted site as plain files in `dist/`

## Read before you start

Skills live in `.claude/skills/`; read the one that fits before the first edit.

| Topic                                                                      | Read                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Where code goes, layers, what may import what, a new module or key         | `architecture`                                                        |
| The web app: client modules, modes and columns, saving, backends           | `architecture` → `references/web-app.md`                              |
| Dev loop, ports, hot reload, test tiers, fixtures, CI, verifying in Chrome | `architecture` → `references/dev-workflow.md`                         |
| Writing a test, a Chrome test, a red or flaky CI run                       | `architecture` → `references/dev-workflow.md` (Tests that hold on CI) |
| Paged.js surprises, upgrading the vendored copy                            | `architecture` (Paged.js) → `references/pagedjs-*.md`                 |
| Hosted site, `dist/`, Deno Deploy, GitHub Pages                            | `architecture` → `references/hosted-site.md`                          |
| Metadata keys, the `spec` version, upgrades of old books                   | `architecture` (Where a change goes, Standing rules)                  |
| Printing, binding, the `page` section, imposition, folios, proofs          | `bookbinding`                                                         |
| UI behaviour, modes, panels, wording, status messages                      | `ux-principles`                                                       |
| Chrome and site visuals: tokens, type, colors, components, dark mode       | `rubric-design` (then `design-language.md`)                           |
| Source text (Gutenberg, pasted, OCR) → BML `manuscript.md`                 | `convert-manuscript`                                                  |
| The `bml` CLI: adding, importing, checking, exporting a book, editions     | `bml`                                                                 |
