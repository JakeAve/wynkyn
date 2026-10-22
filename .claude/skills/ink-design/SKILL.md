---
name: ink-design
description: Use when building or changing anything visible in the editor chrome — a panel, dialog, button, toolbar, list, row, status line, editor theme, icon, empty state, hover, focus or active state, or a light/dark colour — so it follows the app's Ink direction and reuses the tokens in web/app.css instead of inventing literals. Use it even for a one-line style tweak, and whenever a mockup or new component is being judged for fit.
---

# Ink: the visual direction

Chosen 2026-08-31 over a warm-serif "Atelier" and a floating-card "Studio":
one flat plane, hairline separators, hierarchy carried by type alone, an
inverted black/white pill for the active thing, light first with a dark mode.
The pages in the preview are the only objects with depth; the chrome around
them stays quiet so the book is what you look at.

## Tokens (`web/app.css`, top of file)

`:root` is light; `:root[data-theme="dark"]` redefines the same names. Dark
mode is tokens only — no component knows which theme it is in.

| Use | Token |
| --- | --- |
| the one chrome surface / the desk the pages sit on | `--bg` / `--desk` |
| hairlines / row separators inside lists / hover wash | `--line` / `--soft` / `--hover` |
| text / secondary text | `--fg` / `--muted` |
| active pill | `--inv-bg` + `--inv-fg` |
| status only | `--ok`, `--warn`, `--err` |
| editor syntax | `--syn-k` sentinels, `--syn-c` comments, `--syn-t` prose, `--syn-p` punctuation, `--syn-slug`, `--syn-key` |
| drawn on the pages (paper-white in both themes, so fixed dark ink) | `--paper`, `--pick`, `--hover-ring`, `--hl`, `--sheet-*` |
| shape and type | `--radius` 6px, `--fs` 13.5px, `--fs-sm` 11px, system-ui |
| pane widths, persisted | `--w-tree`, `--w-editor` |

CodeMirror is themed from the same variables, so a theme switch needs no
editor reconfigure.

## Patterns

- **Ghost buttons** (`.btn`): no background, no border, `--muted` text, radius
  `--radius`; hover gets `--hover`, the active one is the inverted pill.
- **Sections** separate with a 1px `--line`, never a box or a card. Rows inside
  a list separate with `--soft`.
- **Hierarchy** is weight, size and `--muted`, not colour. There are no
  coloured accents; `--ok`/`--warn`/`--err` exist for status text and marks.
- **Focus** is a 2px `--fg` outline, offset 1px; the editor suppresses its own.
- **Shadows** only under pages (`--page-shadow`) and dialogs (`--backdrop`).
- **Controls** come from `web/src/panel-controls.ts` — `h`, `icon`, `stepper`,
  `seg` (segmented toggle), `toggle`, `select`, `row`, `section`, `moreCss` —
  so every control already looks right; build new views from them before
  writing CSS.
- **Side columns** carry their own toggle at their own edge of the toolbar, a
  panel icon whose side is half filled while the column shows.

## Rules of thumb

- No literal colours in TypeScript, editor themes or component CSS; add a token
  if one is genuinely missing, then use it in both themes.
- The style panel never covers the preview: it takes the editor's grid slot.
- A new surface should be hard to notice. If it draws the eye away from the
  pages, flatten it.
- Check both themes before calling a visual change done
  (`resize_window` with `colorScheme`).

Comparison canvas of the three directions:
https://claude.ai/code/artifact/5ab05a6d-3764-46fe-b341-d1ef07b336b1
