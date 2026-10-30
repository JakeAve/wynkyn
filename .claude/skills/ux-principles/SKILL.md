---
name: ux-principles
description: Use when designing or changing how the editor behaves for its user — adding a control, mode, panel section, flow, shortcut, status or error message, click-to-style behaviour, wording — or when judging whether a feature belongs in the UI at all and in which column. Read it before touching web/src/config-panel.ts, panel-*.ts, preview.ts, the mode handling in app.ts, or spec §7, and before proposing UI from another book-making tool.
---

# UX principles

## Who it is for

A hobby binder making a book or two, who does not know CSS and should not need
to. Plain words ("Space between paragraphs"), steppers and toggles, raw CSS only
behind a collapsed "More CSS" disclosure. The panel never hides power — it
orders it.

## The book is the interface

- Clicking anything in the preview is the main way in. In **Style** it opens
  that element's styles in the middle column; in **Write** it moves the cursor
  to the element's source line. Page furniture has no source line, so a click on
  it always opens its style. Hover outlines only what a click would style.
- You style a rule, not a page: a change applies to every chapter title, every
  pullquote. So every control says where it applies — "On N pages" — and
  hovering that label outlines every match.
- The preview is not an approximation. It is the same Paged.js layout the
  export prints, so anything shown must be true on paper.

## Three columns, one rule

**Left is where you are, middle is what you're changing, right is the
result.** The mode switch (Write ⌘1, Style ⌘2, Publish ⌘3; ⌘, also opens Style)
picks all three, and the mode persists across reloads. ⌘K opens the command
palette in any mode: commands, sentinels, chapters, pages and styles in one
list, and a pick that lives in another mode switches there first; one that
can't run now shows dimmed.

| Mode | Left | Middle | Right |
| --- | --- | --- | --- |
| Write | outline | BML editor | preview |
| Style | book settings and parts | the chosen part's styles | preview |
| Publish | print and e-book rows | page setup and exports | the first signature as it prints |

Tabs and lists are for what you cannot click on. Contents toggles from the
toolbar (⌘\); in Write the pages hide with ⌘. alone, no button (Style and
Publish always show them); both persist; gutters
drag. The write pane and the pages pane each expand from their header's
top-right corner (⌘⇧↩, esc returns), per mode. A hidden preview still lays out,
since Paged.js paginates by measuring.

## The file stays the truth

- `manuscript.md` and `metadata.json` on disk are the only state. The panel is
  a view of the JSON: it never drops a key it doesn't understand and never
  converts a unit silently (steppers keep pt/em/mm; step 0.5 pt, 0.05 em, 1 mm).
- Edits land on disk debounced; the live loop pushes the result back. Versions
  are tagged: a client ignores what it already reflects, reloads silently when
  it has no unsaved edits, otherwise shows the changed-on-disk banner (Reload /
  Keep mine). A save on a stale version is refused (409), never merged.
- Inherited values show greyed with their source; edited values carry a dot; a
  per-view Reset clears only that view's keys.

## Taste

- One visible setting beats an invisible default.
- Two controls for two stored values; never a third that restates them (the
  "setup" dropdown was cut for this).
- Derived facts are shown, not editable: the imposition summary, where furniture
  is dropped, "Used by" chips on a font.
- Status text is short and says what to do next ("Server restarted — reload").
- Don't copy Vellum or Atticus; they only toggle things on and off. The
  differentiators here are typographic control (TOC leaders, numbering styles,
  furniture placement) presented in plain words.
- Controls live with what they control: a pane carries its own controls in its
  own header; the toolbar holds only what is global.
- Follow the Rubric look (`rubric-design` skill, `design-language.md`); the
  panel never covers the preview.

## Read next

- Spec §7.1 (layout), §7.2–7.6 (tree, editor, sentinel styling, panel,
  preview) — update the section you change in the same diff.
- `web/src/style-catalog.ts` — how a click resolves to a metadata path and
  how parts group; `panel-controls.ts` — the primitives.
