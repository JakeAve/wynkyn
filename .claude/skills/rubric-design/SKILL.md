---
name: rubric-design
description: Use when building or changing anything visible in the editor chrome or the hosted site — a panel, dialog, button, toolbar, pane header, list, row, menu, status line, banner, editor theme, icon, empty state, hover, focus or selected state, a font or type size, a spacing or radius, or a light/dark color — so it follows the Rubric design language (design-language.md) and reuses the tokens in web/tokens.css instead of inventing literals. Use it even for a one-line style tweak, and whenever a mockup or new component is being judged for fit.
---

# Rubric: the visual direction

`design-language.md` at the repo root is the source of truth for how the app
and the site look. Read it before the first edit: the principles, then the
section for what you are touching. A heading marked **(planned)** is agreed
but not built yet; build toward it, not toward what the CSS does today. When
the code and the doc disagree and the doc does not say which wins, ask.

## Keep it current

- The doc changes in the same diff as any visible change; drop a heading's
  **(planned)** tag in the diff that builds it.
- A new token, component or pattern goes into the doc before it is used.
- Tokens live in `web/tokens.css`; `web/design-tokens_test.ts` checks them
  against the doc both ways and bans stray `px`. Fix the doc or the CSS when it
  fails, never the test.

## Rules of thumb

- **One red.** Minium (`--acc`, `--acc-ink` for text) only where §2.2 allows:
  marks, focus, the selected thing, at most one primary action. Never a region,
  a pane border or decoration. Errors are crimson `--err`, never the accent.
- **Selected takes the wash.** `--acc-wash` + `--acc-ink` for the current row,
  segment, pressed toggle, menu item, recommended choice. No black pill.
- **rem, not px.** Every length is a token (`--fs-*`, `--s-*`, `--h-*`,
  `--r*`) or em/ch inside text; px only for `--hair` 1px and `--ring` 2px.
  Never set `html { font-size }`.
- **Faces.** Alegreya Sans (`--f-ui`) for every control; IM Fell Great Primer
  (`--f-title`) for display only, never below 1.125rem; Alegreya (`--f-text`)
  for the writing and the book name.
- **Identifiers in `--f-hivis`.** Slugs, image filenames, `{is}` names, folder
  names, URL and hex fields, More CSS. Never labels or words.
- **Controls live with their pane.** A pane's controls go in its own header;
  the toolbar holds only what is global.
- **No literal colors** in TypeScript, editor themes or component CSS; build
  from `web/src/panel-controls.ts` primitives before writing new CSS.
- Corners pair `--r` with `corner-shape: var(--corner)`; switches are pills.

## Before calling it done

Look at it in both themes (`resize_window` with `colorScheme`, or Playwright
with Chrome per `architecture` → `references/dev-workflow.md`).
