# Rubric: Wynkyn's design language

How the editor chrome and the hosted site look. Agreed 2026-10-26; replaces
**Ink** (2026-08-31). This file is the source of truth: when the code and it
disagree, ask.

Named for rubrication: the scribe's and early printer's practice of picking out
headings, initials and structure in red ink. That is exactly what the one accent
colour does here.

A heading marked **(planned)** describes agreed design that is not built yet;
the chrome still looks the old way there. Unmarked sections are built (or, like
the principles, always apply).

Visual references (private artifacts; this document stands without them):

- Components and tokens: https://claude.ai/artifact/G7Eb95EXE1p7sCAG49So3S
- Write mode, Prose / Source, expanded views:
  https://claude.ai/artifact/18o9oYrbnwbSZTMMS24RMb
- Type, ink, corners, selection, paper explorer (preset "Your pick"):
  https://claude.ai/artifact/GtQNdi3WxhLZVzxMr542Fg
- The landscape survey that started it:
  https://claude.ai/artifact/G6X4tkYLzDmDESxVPnPBCb

## Keeping this current

- Update this file in the same diff as any change to what the chrome or the site
  looks like, and drop a heading's **(planned)** tag in the diff that builds it.
- A new token, component or pattern goes in here before it is used.
- Tokens live in `web/tokens.css`, which `web/app.css` and the site pages both
  load. `web/design-tokens_test.ts` checks both ways: every token there is named
  here, and every token named here exists there (range names like `--s-*` and
  `--sheet-*` stand for the family; a struck-through name, ~~`--soft`~~, is
  retired). It also bans stray `px` (§4.1). When it fails, fix the doc or the
  CSS; never loosen the test.
- `web/components.html` is the living component sheet: the real components on
  `web/tokens.css` and `web/app.css` alone, with the app's own class names and
  container ids (served at `/web/components.html` by `deno task dev` and the
  hosted site). A new or changed component gets a board there in the same diff.

---

## 1. Principles

1. **The book is the interface.** The pages are the only objects with depth; the
   chrome is one quiet plane around them.
2. **As minimal or as powerful as you need.** Every pane opens in its simple
   form; depth is one control away in the pane it belongs to, never a separate
   screen. Power is ordered, not hidden.
3. **One red.** A single vermilion-red printer's ink (minium) marks structure,
   position and the one action that matters. Everything else is ink on paper.
4. **Plain words first, winks second.** Every label is the plain word. The
   period flavour lives in glyphs, small caps, tooltips, status lines and empty
   states, where nobody has to decode it to get work done.
5. **Controls live with what they control.** A pane carries its own controls in
   its own header. The toolbar holds only what is global.
6. **Sizes follow the reader.** Everything is in rem off the browser's own text
   size, so a reader who sets larger text gets a larger app, not clipped labels.

## 2. Colour

### 2.1 Paper and ink (neutrals)

The interface is drawn on one **UI paper** colour and one ink. Every other
neutral is mixed from those two in OKLab, so the chrome stays in key and dark
mode needs no hand-tuned greys. UI paper is neutral `#fafafa`.

| Token     | Light                      | ≈ Light   | Dark                       | ≈ Dark    |
| --------- | -------------------------- | --------- | -------------------------- | --------- |
| `--paper` | the UI paper               | `#fafafa` | (same input)               |           |
| `--bg`    | `--paper`                  | `#fafafa` | `mix(--paper 4%, #0e0e0e)` | `#151515` |
| `--fg`    | `mix(--paper 6%, #101010)` | `#1b1b1b` | `mix(--paper 94%, #000)`   | `#ececec` |
| `--desk`  | `mix(--fg 6%, --bg)`       | `#ebebeb` | `mix(#000 45%, --bg)`      | `#040404` |
| `--hover` | `mix(--fg 5%, --bg)`       | `#eeeeee` | `mix(--fg 8%, --bg)`       | `#222222` |
| `--line`  | `mix(--fg 11%, --bg)`      | `#dedede` | `mix(--fg 13%, --bg)`      | `#2b2b2b` |
| `--muted` | `mix(--fg 62%, --bg)`      | `#676767` | `mix(--fg 62%, --bg)`      | `#919191` |

`mix(a p%, b)` is `color-mix(in oklab, a p%, b)`. Retired from Ink:
~~`--soft`~~, ~~`--inv-bg`~~, ~~`--inv-fg`~~ (the black pill, see §6.1).

The UI paper is fixed at neutral. The derivation is what would make a UI tint
possible later; it is not a setting.

### 2.2 The red: minium

Red lead, the vermilion-red of early printed rubrics. Two strengths, because the
bright pigment is too light to carry small text.

| Token        | Use                                  | Light                    | Dark        |
| ------------ | ------------------------------------ | ------------------------ | ----------- |
| `--acc`      | marks and fills: cursor, dots, rules | `#db3834`                | `#ef6d62`   |
| `--acc-ink`  | red text, red icons                  | `#b12926`                | `#f49287`   |
| `--acc-wash` | the selected thing's background      | `--acc` 10%, transparent | `--acc` 16% |
| `--acc-btn`  | primary button fill                  | `--acc-ink`              | `--acc`     |
| `--on-acc`   | text on the primary button           | `#ffffff`                | `--bg`      |

`--acc-wash` is `color-mix(in srgb, var(--acc) 10%, transparent)`, so it sits on
any surface.

**Where the red goes (the rubrication rules).** Only here:

- Sentinel names in Source and rubrics in the Prose margin (§8).
- The text cursor and text selection.
- Focus rings and focused field borders.
- The selected thing: nav rows, segments, the recommended choice, a pressed
  toggle button, the current menu item.
- Edited-value dots.
- The outline on the pages around what is being styled or where the cursor is.
- Switches that are on.
- At most one primary action per screen.
- The sun mark (§10).

**Never:** backgrounds of regions, large fills, borders of panes, decoration,
and never errors (§2.3).

### 2.3 Status

Errors must not read as the accent: they are a crimson, bluer than minium, and
always carry a word and an icon.

| Token    | Light     | Dark      | Use                                         |
| -------- | --------- | --------- | ------------------------------------------- |
| `--err`  | `#a4233f` | `#f0899b` | errors, spell-check underline, parse errors |
| `--warn` | `#80651a` | `#d9b768` | warnings, the spec banner, find-match tint  |
| `--ok`   | `#3d7350` | `#93c4a0` | done ("Added to the book's images as …")    |

`--warn-wash` and `--err-wash` (9% / 8%) tint a banner's background.

### 2.4 Drawn on the pages

The pages stay paper in both themes, so their marks use fixed values.

- `--stock`: the book's paper stock (§2.5), default `#fffefc` (Ink called it
  `--paper`; that name is now the UI paper).
- `--pick`: the light `--acc`, for the styled element or the cursor's block.
- `--hover-ring`: `rgb(22 22 22 / .32)`, unchanged: the outline on a hovered or
  "On N pages" element.
- `--hl`: `rgb(22 22 22 / .07)`, unchanged: the faint fill behind the "On N
  pages" matches.
- `--page-shadow`: the shadow under each page (§5); this one does follow the
  theme, deeper on dark.
- `--sheet-*`: the imposed sheet in Print (paper, edge, slot, blank, ink, fold,
  cut), unchanged, except `--sheet-cut` becomes the light `--acc`.
- `--inspect-*`: Inspect's marks (spec §7.6), drawn in their own layer over the
  pages, screen only. `--inspect-hover` `#2563eb` rings what the pointer is on
  and draws a pinned line's baseline; the box model as DevTools shades it:
  `--inspect-space` amber `rgb(245 158 11 / .22)` above and below,
  `--inspect-indent` green `rgb(34 160 90 / .22)` for the first-line indent,
  `--inspect-content` `rgb(37 99 235 / .10)` for the content box;
  `--inspect-ghost` `rgb(11 107 79 / .6)` dashes a running head or page number
  the page map dropped; `--inspect-ink` `#1b1b1b` draws ⌥'s measure lines and
  pills (their text `--inspect-tag`) and the hover tag's text, on
  `--inspect-tag` `#fafafa` with `--shadow-pop`, its name in `--inspect-hover`.
  The pinned thing takes a 2px `--pick` ring, the block a pinned line or span is
  in a dashed one; nothing else on the pages is minium.

### 2.5 Paper stock (per book)

The preview pages take the book's paper stock, saved in `metadata.json` as
`page.paper` (any CSS colour; absent = the default stock, Bright white), merged
and upgraded like any other `page` key. Kept deliberately quiet:

- One row in Style → Page size & margins, "Paper stock": `swatches` (§6.5) for
  Bright white (unset, the default `--stock`), Natural `#fbf8f1`, Ivory
  `#f8f2e3`, Cream `#f3e9d2`, Recycled grey `#f1f0ec`, then a custom colour. No
  prompt, banner or first-run question.
- `setPaperStock` (`preview.ts`) sets `--stock` on `#preview`, so only the live
  pages change. The pages are paper in both themes, so the stock is the same in
  dark: the five are all near-white, never a mood.
- Preview only. Print sheets and Print pages clear the page background, and
  `generatePagedCSS`, `bml export` and EPUB never read the key: all stay white.
- Never touches the manuscript; the colophon's `{paper}` line is the author's
  text.

### 2.6 Source view syntax

| Part                         | Token                     | Colour                  |
| ---------------------------- | ------------------------- | ----------------------- |
| sentinel name                | `--syn-k`                 | `--acc-ink`, 500        |
| braces, colons, pipes, slugs | `--syn-p`                 | `--muted`               |
| `%%` comments                | `--syn-c`                 | `--muted`               |
| prose                        | `--syn-t`                 | `--fg`                  |
| selection                    | `--sel`                   | `--acc-wash`            |
| active line                  | `--active`                | `--fg` at 2.5%          |
| find matches / current       | `--match` / `--match-cur` | `--warn` at 30% / 60%   |
| structural sentinel band     | `--struct`                | a faint band, unchanged |
| text the open edition skips  | `--off`                   | opacity .38             |

The editor's CodeMirror theme reads these variables, so a theme switch needs no
reconfigure. Ink's sage ~~`--syn-key`~~ and bronze ~~`--syn-slug`~~ are retired.

## 3. Type

Two families, plus the system's own monospace.

| Role                                | Face                                      | Weights        |
| ----------------------------------- | ----------------------------------------- | -------------- |
| Interface: every control and label  | **Alegreya Sans**                         | 400, 500, 700  |
| Display titles                      | **IM Fell Great Primer**                  | 400, 400i      |
| Writing, the book name, small serif | **Alegreya**                              | 400, 500, 400i |
| Source view                         | the system monospace                      | (system)       |
| High-visibility strings (§3.1)      | `--f-hivis`, the system monospace for now | (system)       |

Tokens: `--f-ui` (Alegreya Sans), `--f-title` (IM Fell Great Primer), `--f-text`
(Alegreya), `--f-mono` (the system monospace), and `--f-hivis` (`var(--f-mono)`
today; §3.1).

- **Alegreya Sans** for the interface: Alegreya's own sans, drawn alongside it,
  so the chrome and the writing read as one family. Its default figures are
  old-style; the interface sets `font-variant-numeric: lining-nums` on `body`
  and adds `tabular-nums` wherever digits line up (steppers, counts, the
  footer).
- **IM Fell Great Primer** for display titles: the Fell types, digitised from
  17th-century printing, rough edges kept. Its texture gets blotchy when small:
  used at `--fs-h` (1.375rem) and up, **never below 1.125rem**.
- **Alegreya** for the writing (Prose view), the book name in the toolbar, and
  any serif text below Fell's floor.
- **Monospace**: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`, not
  vendored; Source only needs to read as code.
- Alegreya, Alegreya Sans and IM Fell Great Primer are OFL and vendored as woff2
  under `vendor/fonts/` with their licences: the app runs offline over the
  author's folder and the chrome must not depend on a font CDN.

Considered and set aside (2026-10-26): Atkinson Hyperlegible Next for the
interface. It is the most legible at small sizes, but in this app the only
places it matters are covered by §3.1. If small text proves hard to read in use,
it is the first thing to try: it changes `--f-ui` and the scale's sizes, nothing
else.

### 3.1 High-visibility strings

Wherever a reader must tell I from l from 1 or O from 0 with no words around to
help, the text is set in `--f-hivis` (at `--fs-sm`, the interface's colour).
Today that is the system monospace; it can become Atkinson Hyperlegible Mono or
Next by changing that one token.

Always `--f-hivis`:

- image slugs and filenames (completions, "Added to the book's images as …");
- chapter and part slugs (the outline's fallback label, the Prose margin);
- `{is}` style names in the style nav and panel;
- a book folder name shown as typed (the title dialog's folder);
- typed codes: the web-address field, a hex colour field, More CSS.

Never: labels, menus, numbers, words. Context reads those.

In `web/app.css` the `.hivis` class sets it (`--f-hivis` at `--fs-sm`) on a slug
standing in for a title in the outline (`tree-view.ts`), an `{is}` name in the
style nav (`config-panel.ts`) and the filenames in the footer's "Added to the
book's images as …" (`app.ts`). Image completions, the web-address field
(`#web-url`) and the title dialog's folder (`#title-slug`) set it in their own
rules; More CSS already did. Switcher book rows stay in `--f-ui`: they show the
folder title-cased (`titleCase`), which reads as a title, not a code.

### Scale

All sizes in rem; px at the default 16px root.

| Token       | rem                    | px           | Face, weight         | Use                                                                |
| ----------- | ---------------------- | ------------ | -------------------- | ------------------------------------------------------------------ |
| `--fs-2xs`  | 0.75                   | 12           | Alegreya Sans        | counts ("9 set"), kbd                                              |
| `--fs-xs`   | 0.8125                 | 13           | Alegreya Sans        | notes, hints, footer, crumbs, units                                |
| `--fs-sm`   | 0.875                  | 14           | Alegreya Sans        | small controls, dense rows; small-caps labels; `--f-hivis` strings |
| `--fs`      | 0.9375                 | 15           | Alegreya Sans        | the default for everything                                         |
| `--fs-lg`   | 1.0625                 | 17           | Alegreya 500         | the book name in the toolbar; dialog lead text                     |
| `--fs-h`    | 1.375                  | 22           | Fell Great Primer    | a style view's heading, dialog titles                              |
| `--fs-hero` | 1.75                   | 28           | Fell Great Primer    | empty states                                                       |
| writing     | 1.0625                 | 17           | Alegreya             | Prose view (a reader setting; 19 when expanded)                    |
| source      | 0.8125                 | 13           | monospace            | Source view (scales with the reader's text size)                   |
| site        | 2.875 / 1.125 / 1.0625 | 46 / 18 / 17 | Fell / Alegreya Sans | §11                                                                |

Alegreya Sans at 15px has the x-height of a typical UI sans at 14px and runs
about 7% narrower, so the panel holds as much as before. Its small sizes sit a
step higher than Ink's (12 and 13px, not 10.5 and 11px) because it shrinks
faster than a legibility face.

- Line height `--lh` 1.45 for interface text, `--lh-tight` 1.2 for Fell
  headings, 1.62 for the writing. Unitless.
- **Group labels** (style nav, outline, panel sections, menu headings):
  `--fs-sm`, `font-variant-caps: all-small-caps`, tracking `--track-caps`
  (`0.08em`), `--muted`, 500.
- Hierarchy is weight, size and `--muted` first. Fell only for display; Alegreya
  only for the writing and the book's name; never a serif in a control.

## 4. Units, space and size

### 4.1 Units

| What                                               | Unit                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| font sizes                                         | rem, from the scale (§3)                                                                    |
| padding, gaps, margins                             | rem, from `--s-*`                                                                           |
| control and bar heights                            | rem, from `--h-*`                                                                           |
| radii, icon sizes                                  | rem                                                                                         |
| hairlines, focus rings, 1px shadow rings           | px (`--hair` 1px, `--ring` 2px)                                                             |
| letter spacing, prose measure, offsets inside text | em / ch (the 36em measure stays)                                                            |
| line height                                        | unitless                                                                                    |
| pane widths (`--w-tree`, `--w-editor`)             | rem defaults and minimums; px once dragged (a drag is in pointer pixels and persists as px) |
| book and page geometry                             | the book's own units (in, mm, pt, em) — metadata, never chrome                              |
| the root                                           | never set: `html` keeps the browser's size                                                  |

Ink's `web/app.css` had 590 px values, 14 font sizes, 11 radii and about 20
paddings; each now maps onto a token below, values in between rounded to the
nearest step (10px gaps became `--s-4` or `--s-5`, 12.5px text `--fs-sm`).
Lengths with no token (a dialog's width, a menu's, the panel's page drawings)
are plain rem. Pills are `999rem`. `web/design-tokens_test.ts` fails on any
other px in `web/app.css`, except in rules for the book's own geometry: the
preview's pages (`.pagedjs_*`) and the strokes of the sheet drawing.

### 4.2 Space

A 4px grid, in rem.

| Token   | rem   | px | Typical use                                 |
| ------- | ----- | -- | ------------------------------------------- |
| `--s-1` | 0.125 | 2  | inside segments, between list rows          |
| `--s-2` | 0.25  | 4  | icon to label, menu padding                 |
| `--s-3` | 0.375 | 6  | small control padding, tight gaps           |
| `--s-4` | 0.5   | 8  | control padding, row gaps                   |
| `--s-5` | 0.75  | 12 | section padding, margins beside the writing |
| `--s-6` | 1     | 16 | panel and dialog padding                    |
| `--s-7` | 1.5   | 24 | between groups                              |
| `--s-8` | 2     | 32 | dialog backdrop inset, empty states         |
| `--s-9` | 3     | 48 | page-level spacing on the site              |

### 4.3 Size

| Token         | rem   | px | Use                                        |
| ------------- | ----- | -- | ------------------------------------------ |
| `--h-sm`      | 1.5   | 24 | small buttons, pane-header controls, chips |
| `--h-md`      | 1.75  | 28 | the default control height                 |
| `--h-lg`      | 2.25  | 36 | dialog actions, the site's button          |
| `--h-pane`    | 2.375 | 38 | pane header                                |
| `--h-toolbar` | 2.875 | 46 | toolbar                                    |
| `--h-footer`  | 1.875 | 30 | footer                                     |
| `--icon`      | 1     | 16 | icons (16-unit grid, 1.4 stroke)           |

24px is the smallest hit target (WCAG 2.2 AA minimum).

## 5. Shape

```css
--r: 0.25rem; /* controls */
--r-pop: 0.375rem; /* menus, popovers, tooltips */
--r-dlg: 0.5rem; /* dialogs */
--corner: superellipse(-1.4); /* a shallow scoop */
```

Every rounded thing pairs its radius with `corner-shape: var(--corner)`. Chrome
139+ draws the scoop, with borders, focus rings and backgrounds following it.
Firefox and Safari ignore `corner-shape` and draw a plain round corner of the
same radius; no clip-path imitation.

| Thing                                                           | Shape                      |
| --------------------------------------------------------------- | -------------------------- |
| buttons, segments, fields, selects, nav rows, chips, menu items | `--r` + `--corner`         |
| menus, popovers, tooltips                                       | `--r-pop` + `--corner`     |
| dialogs                                                         | `--r-dlg` + `--corner`     |
| switches                                                        | a full pill, always        |
| dots                                                            | circles                    |
| panes, columns, toolbar, footer                                 | square, hairline-separated |
| book pages                                                      | square                     |

**Depth:** shadows only under pages (`--page-shadow`), popovers and the outline
slid in over an expanded view (`--shadow-pop`), and dialogs (`--shadow-dlg` over
`--backdrop`).

## 6. Components

The sheet (`web/components.html`, built on the app's own CSS) shows each. They
are built from `web/src/panel-controls.ts` primitives (`h`, `icon`, `stepper`,
`seg`, `toggle`/`switchInput`, `select`, `row`, `section`, `moreCss`) and the
shared CSS classes; this section is what each must look like.

States, everywhere: **hover** `--hover` wash; **focus** 2px `--acc` ring offset
1px (fields: border turns `--acc` plus a 1px `--acc` ring); **selected /
pressed** `--acc-wash` + `--acc-ink`; **disabled** 45% opacity, no pointer
events.

### 6.1 Button

| Variant | Look                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ghost   | default. No border or fill, `--muted` text, `--h-md`, padding `0 --s-4`. Hover: `--hover`, `--fg` text.                        |
| pressed | a toggle button that is on (`toggle` in `panel-controls.ts`, e.g. "Italic"; `aria-pressed`): the red wash.                     |
| icon    | square at its height, icon `--icon`.                                                                                           |
| small   | `--h-sm`, `--fs-sm`, padding `0 --s-3`. Pane headers, banners, section resets.                                                 |
| primary | `--acc-btn` fill, `--on-acc` text, 600, padding `0 --s-5`; hover mixes 12% ink in. One per screen at most.                     |
| large   | `--h-lg`, padding `0 --s-6`. Dialog actions and the site.                                                                      |
| outline | a 1px `--line` inset ring, `--fg` text. Rare: a secondary action that must read as a button out of context ("Choose folder…"). |

Ink's inverted black pill is gone everywhere. Labels are one line
(`white-space: nowrap`); text that may wrap is not a button.

In `web/app.css`: `.btn` is the ghost and `.btn.primary` the primary, anywhere.
Inside the style panel a `toggle` (`.tog`) keeps a 1px `--line` frame so it
reads as a control beside the fields, and drops it for the wash when pressed;
`.tog.primary` and `.tog.outline` (`--fg` text) are the panel's actions, e.g.
Publish's one primary "Print sheets" beside the outlined "Print pages" and
"Export EPUB". `.btn.sm` (banners), `.btn.lg` (the empty state) and `.btn.icon`
(with `.sm`, the pane headers' expand and the pages' zoom − and +) are built;
`.btn.outline` is the Inspect drawer's two actions.

### 6.2 Segmented control (`seg`)

One choice among two to five. A 1px `--line` frame with `--s-1` inset; segments
`--h-md` minus the inset, `--muted`; the chosen one takes the red wash.
Variants: icon segments (square), small (`--h-sm`, pane headers), and the
toolbar's mode switch (the same control). `role="radiogroup"`, `aria-checked`.
`allowNone` lets a click on the chosen segment clear it.

### 6.3 Fields

- **Frame:** `--h-md`, 1px `--line` on `--bg`, `--r` + corner. Focus: border
  `--acc` plus a 1px `--acc` ring.
- **Stepper:** − and + as `--h-sm`-wide buttons inside the frame, the number
  centred in tabular figures (about 3.25rem), the unit beside it in `--fs-xs`
  `--muted` (a select when the unit can change). Steps stay 0.5pt / 0.05em /
  1mm; units are never converted.
- **Select:** native `<select>`, custom chevron (a mid-grey stroke that reads on
  both papers), padding-right `--s-7`.
- **Text and search:** the same frame; search has a leading icon.
- **Code** (More CSS): `--f-hivis` `--fs-sm`, at least 5.5rem tall, resizes
  vertically.
- **Inherited value:** text `--muted` and italic (a stepper shows it as its
  placeholder); the row names the source (§6.5).

### 6.4 Switch

`switchInput`: a checkbox with `role="switch"`. 1.875 × 1.0625rem pill, `--line`
off, `--acc` on, a `--paper` knob with a 1px shadow, `--t-fast` slide. Always a
pill, whatever the corner shape.

### 6.5 Panel: view heading, section, row

- **View heading:** crumb (the nav group, `--fs-xs`, `--muted`) over the heading
  in Fell `--fs-h`, with "On N pages" right-aligned (`--fs-xs`, dotted
  underline; hovering outlines every match, a click steps through them). A
  hairline below. `applies` in `panel-controls.ts` makes "On N pages"; a view
  with just one shows it in the heading, a view of several elements (an opener's
  number and title) keeps one at each section label's right.
- **Section** (`section`): `--s-5` vertical padding, a hairline below, a
  small-caps group label. (planned: the view's Reset as a small icon button at
  the label's right when the section has set values; today it sits at the view's
  foot beside "N settings in this book".)
- **Row** (`row`): label column 8.5rem, control left-aligned in the rest,
  `--h-md` minimum, `--s-4` gap. A 0.375rem `--acc` dot before the label marks a
  value this view set; an inherited value's label carries "from Body text" in
  `--fs-xs` `--muted` beneath.
- **Swatches** (`swatches`): `--h-md` colour chips with a hairline edge, each
  named in its tooltip, then a native colour picker the same size and its code
  in a text field in `--f-hivis`; any CSS colour can be typed. Until a custom
  colour is chosen the picker shows a soft hue wheel (oklch, lightness 0.82,
  chroma 0.1), never white, so it can't pass for a white chip; this is the one
  literal colour in the chrome. The chosen chip, or the picker when the value is
  none of them, sits in `--acc-wash` inside a 1px `--acc` frame (the wash alone
  is lost around a warm chip). An option valued `""` means unset.
- **Tip line** (`.tip`): a red ☞ in Fell before `--fs-sm` `--muted` text.
- **More CSS** (`moreCss`): a `details` whose summary is a chevron and "More CSS
  for page numbers (n)" in `--fs-sm` `--muted`; the chevron turns 90° open.

### 6.6 Lists: style nav, tree, outline

Group label (§3) then rows: padding `--s-2 --s-4`, `--r` + corner, `--s-1`
apart, a right-aligned count in `--fs-2xs` `--muted`. Hover wash; the current
row takes the red wash. Nesting indents by `--s-4` per level. No separators. In
`web/app.css`: `:is(#tree, #style-nav) .nh` is the label, `#style-nav .ni` and
`#tree .tree-node` the rows; the switcher's `.book-row` follows the same rules.

### 6.7 Choice list

How a dialog asks one question. Full-width rows: a 500 title over a `--fs-xs`
`--muted` note, padding `--s-4 --s-5`, `--s-1` apart. Hover wash; the
recommended choice carries the red wash and a red title (Ink's `.choice.primary`
black pill became this). The library dialog stays the reference. `.choices`
bleeds `--s-5` into the dialog's padding so the titles line up with its heading;
a tag on a choice ("Chromium only") is the experimental chip (`.pill`, §6.10).

### 6.8 Dialog

`--bg`, `--r-dlg` + corner, `--shadow-dlg` over `--backdrop`; width by content
up to about 26rem (wider only for the font picker and themes). Header: title in
Fell `--fs-h`, optional lead in `--muted`. Padding `--s-6`. Footer: actions
right-aligned, `--s-3` apart, ghost first, primary last. `esc` closes it unless
it guards unsaved work (closing on a backdrop click: planned). In `web/app.css`:
`.ask` with `.ask-foot`; fields in a dialog (`.ask .field`) are §6.3 frames.

### 6.9 Menu, popover, tooltip

- **Menu / popover:** `--bg`, 1px `--line`, `--r-pop` + corner, `--shadow-pop`,
  padding `--s-2`. Items `--h-md` tall, a 1rem check column, a right column for
  kbd or detail. Current item: red wash and a red check. Separators are
  hairlines bleeding to the edges. Optional small-caps heading. Used by: the
  book and edition switcher (`#switcher`), the font picker (`.fontpop`), `{`
  completions (`.cm-tooltip-autocomplete`), ⌘K (`.cm-bml-palette`), the wrap bar
  and spelling suggestions (`.cm-bml-wrapbar`); Aa and Spelling in the write
  pane's header (`.tvpop`); the pages' zoom menu (`.menu`, a native popover of
  `menuitemradio` rows). Fields inside a popover are §6.3 frames (focus: `--acc`
  border and ring). The find bar (`.cm-bml-find`) is a panel, not a popover, but
  its fields and pressed options follow the same rules.
- **Completion row:** a sentinel's name in `--f-mono` `--fs-sm` `--acc-ink`, a
  7rem column; description `--muted`; how it closes (`{/quote}`, "wraps", "—")
  in mono `--fs-2xs` `--muted` at the right. An image's row is a thumbnail, its
  slug or filename in `--f-hivis` in the row's colour, and its note.
- **Tooltip** (planned): inverted, `--bg` text on an `--fg` fill, `--fs-xs`,
  `--r-pop`, padding `--s-2 --s-3`. Winks go here (§9). Native `title` tooltips
  until then.

### 6.10 Banner, status, chip, kbd

- **Banner:** a strip across the top of the pane it concerns, never a toast. A
  hairline below (the bar above it draws the one above), padding `--s-3 --s-5`,
  `--fs-sm` message, small ghost buttons (`.btn.sm`) right. A warning banner
  adds `--warn-wash` and a warn icon. Changed on disk (`#disk-banner`) is plain
  with its lead in `--err`, because saving has stopped; the spec-version banner
  (`#spec-banner`) is the warning.
- **Status** (planned): icon + bold lead word + plain sentence in the status
  colour: "Can't save: the folder is read-only." Never colour alone. Today's
  lines are the sentence in the status colour (`.sw-err`, `#image-note.warn`).
- **Busy** (planned, with §9's "Setting type…"): a pulsing 6px `--acc` dot +
  "Setting type… 30 pages" in `--fs-xs` `--muted`.
- **Chip:** `--h-sm`, `--fs-xs`, 1px `--line` inset ring, `--r` + corner (quiet
  variant: a `--hover` fill, no ring; experimental: `--warn` text and a 40%
  `--warn` ring). "Used by" chips (`#config-overlay .chip`), tags on a choice
  (`.pill`), edition tags.
- **kbd:** `--fs-2xs` Alegreya Sans, 1px `--line` with a 2px bottom, `--r` +
  corner. One `kbd` rule for the whole app.

### 6.11 Chrome

- **Toolbar** (`--h-toolbar`): left, the Contents toggle (⌘\) and the crumb
  (library / book name in Alegreya `--fs-lg` 500 / edition, `--muted`); centre,
  Write / Style / Publish (⌘1–3); right, the theme toggle alone. The save status
  sits after the crumb.
- **Pane header** (`--h-pane` at least, `.pane-head`): the pane's own controls
  at left in small sizes, `--s-2` apart; its expand button
  (`.btn.sm.icon
  .expand`) pinned to the top-right corner even when the
  controls wrap. A hairline below; the pages pane's header sits on `--desk` with
  none. The pages pane's controls sit at the right instead, beside expand: zoom
  (`#zoom`), `−` and `+` as small icon buttons around the percentage, a small
  ghost in tabular figures that opens the zoom menu (§6.9); then Inspect
  (`#inspect`), a small icon toggle (DevTools' picker arrow) that takes the red
  wash while on. Both hidden in Publish.
- **Footer** (`--h-footer`): split by column, `--fs-xs` `--muted`; the writer's
  cell opens with the stats line (§8.3), the session count in `--acc-ink` once
  non-zero, then Go to style with a dotted underline.

### 6.12 Empty state

Centred: a ❦ in `--acc-ink`, the title in Fell `--fs-hero`, one `--muted`
sentence, one large primary button (`.btn.primary.lg`). `--s-8` padding. In
`web/app.css`: `.empty` (an `h2` and a `p`; the ❦ is drawn). A list with nothing
in it says so in one centred `--muted` `--fs-sm` line (`.book-empty`). The empty
library's create dialog takes `.empty` on its heading block ("Your library is
empty").

### 6.13 Inspect drawer

Under the pages (`#inspect-drawer`, a row of `#pages`) while Inspect has
something pinned, gone otherwise; at most 15.625rem tall, scrolling inside.
Chrome on `--bg`, so it follows the theme; only its box diagram borrows the page
marks' colours (§2.4).

- **Header** (`--h-pane`, a hairline below): the breadcrumb at left, crumbs as
  small `--muted` text buttons with a `--hover` wash, `›` between them; the
  current one `--acc-ink` 500, a crumb that goes nowhere plain. At right, Show
  in manuscript and Open in Style as small outline buttons (§6.1), each only
  when it has somewhere to go.
- **Body:** three columns, `--s-7` apart: Why it's here (1.55fr), Box
  (14.375rem), Type (1fr), each under a small-caps label (§6.5). A reason is a
  `--fs` line over its source in `--fs-xs` `--muted` with a dotted underline.
  Lines: quiet chips (§6.10), numbered, a pinned line's in the red wash.
- **Box:** the DevTools diagram: a dashed amber frame on `--inspect-space` with
  space above and below, a green `--inspect-indent` cell for the first-line
  indent, and the size in a `--inspect-content` box ringed in `--inspect-hover`,
  all in `--fs-2xs` tabular figures; a key below. A span, ghost or empty space
  shows its size alone, in a `--line` frame.
- **Type:** label column 4rem; the value over where it comes from: "Style ›
  Chapter title" when this element sets it, else the value `--muted` with "from
  Body" or "Book default".

## 7. Layout and expanded views

The three-column rule stands: left is where you are, middle is what you're
changing, right is the result.

- **Pane headers.** Write pane: Prose | Source (a small seg), Aa and Spelling
  (small ghost buttons opening §6.9 popovers) at left; expand at right. Pages
  pane: zoom (`−` `100%` `+`), Inspect, then expand, at right; Publish shows the
  sheets, so expand alone. The style panel keeps its view heading inside.
- **Expand.** The write pane and the pages pane each expand from their top-right
  corner (arrows out; arrows in, in `--acc-ink`, while expanded).
  - Expanding the **writing** hides the outline and the pages. The text keeps
    its measure, the margins widen so notes are written out, and the toolbar,
    footer and pane header (except the expand button) fade while typing and
    return when the mouse moves (a control focused by Tab stays visible). The
    writing grows to 19 (§3) with its measure; the margins are §8.1's.
  - Expanding the **pages** shows the spread larger, nothing else. Same in Style
    and Publish.
  - In either, the mouse at the left edge slides the outline in over the view
    (Write's outline, or the Style / Publish nav), with `--shadow-pop`; the
    Contents toggle pins it. While it is out, the pane header steps right of it
    so its controls stay reachable.
  - Return with the same button or `esc`. `⌘⇧↩` expands the pane last used, or
    returns. (`⌘⇧F` stays Footnote.)
  - Expanded state is per mode and persists. A hidden preview still lays out (it
    leaves the grid, never `display: none`).
- **Gone from the toolbar:** the Pages toggle (⌘. stays as a shortcut), focus,
  and every Write-only control. While the pages are hidden, the write pane's
  corner button shows the return state, "Show the pages (⌘.)", and brings them
  back. The pages hide in Write only; Style and Publish always show them.

## 8. The write pane

Two views of the same file, switched in the pane header or with `⌘/`. Nothing is
stored differently.

### 8.1 Prose (default)

The text column holds only the writing, in the writing face (Alegreya by
default).

- **Rubrics, left margin.** Each sentinel that opens or labels a block is a red
  small-caps rubric beside it (`--f-ui` `--fs-xs`, `--acc-ink`, right-aligned):
  `Chapter` (slug beneath in `--f-hivis` `--fs-2xs`, muted, right-aligned and
  truncated within the margin, inset `--s-5` from the pane's edge), `Title`,
  `Drop cap`, `Quote`, `Poem`, `Illustration`, an `{is}` name, `Break`.
  Structural blocks (matter, part, chapter) also draw a hairline (`--line`)
  across the text column. A rubric is a widget against `.cm-content`'s padding,
  not a gutter; Prose has no line numbers. A click on it opens its markup.
  Inline tags have rubrics too, `Em`, `Footnote`, `Ref`, once each beneath the
  line's own rubric and slug (decided 2026-10-26: the margin names every tag, so
  a writer new to them learns what each one is); a line with a stack grows to
  hold it.
- **Text as text.** The line after `{title}` / `{heading}` is set large in Fell
  (2rem at normal width); `{subtitle}`'s line is italic; `{em}` is italic;
  `{break}` is ⁂, centred and muted; quotes, epigraphs, poems and pullquotes
  indent 2em. Not a page preview: no page size, no book styles.
- **Markup on a click.** Markup stays folded while the cursor moves and types: a
  sentinel line folds into the line above, or into its rubric row or stand-in. A
  click on a rubric, ⁂, ☞ or an illustration's image opens that paragraph's
  sentinel lines and inline tags in place (`--f-mono` at .75em, muted, names in
  red), editable as plain text, until the cursor leaves it. Selecting text never
  opens it (decided 2026-10-26: it felt like noise); a sentinel or `%%` line
  alone shows while the cursor is on it (one being typed, a rubric row arrowed
  onto). A key that would change folded markup (a backspace at a title's start)
  opens its paragraph instead, so nothing hidden changes. This replaces Hide
  markup. Plates, drop-cap images, illustrations whose file is missing, and
  footnote and ref tags stay as markup.
- **Notes, right margin.** `%%` comments, including import's `%% check:` notes,
  sit behind a red ☞ as marginalia; the note reads on hover (a native title
  until §6.9's tooltip). Opened, the `%%` line shows in place instead.
  Box-drawing `%%` rules are dropped.
- **Page turns, right margin.** Where a printed page begins: a short rule
  (`--s-5`, `--hair`) and the number in `--muted`, above any ☞, from the last
  layout: the page's printed folio (`data-folio`, as the contents would cite it,
  "vii" or "12"), not its count from the first page. It sits on the block the
  page begins in, not the exact line. Hidden for a paragraph edited since, until
  the next layout lands; Aa's Page turns switch hides them all. Each carries its
  long form, "p. 12" (`data-long`), for the expanded margins.
- **Images.** An `{illustration}` whose file is in `images/` draws as a block
  above its line: the image at most 12rem tall and no wider than the text column
  (corners `--r`), its caption beneath in italics at .85em, `--muted`, and the
  `Illustration` rubric with its slug in the margin beside the image. A click on
  the image opens the markup under it, and the image stays drawn. Decided
  2026-10-26: plates, drop-cap images and illustrations whose file is missing
  stay plain markup lines (shown even without a click, so an unresolved one is
  seen).
- **`{only}`** (experimental) is a rubric `Only` with its editions beneath, the
  way `{is}` shows its name (decided 2026-10-26).
- **Margins.** Left 6rem and right 3rem at normal width, 9.5rem and 10.5rem
  expanded. At normal width rubrics stay (slug truncated), notes collapse to the
  ☞ (hover to read) and page turns show the number alone. Expanded, they are
  written out: the note beside its ☞ in `--fs-xs` `--muted`, the turn as "p.
  12", the slug on up to two lines. The right margin floats there, so a line
  grows to hold its notes and the next line's notes start below them.

### 8.2 Source

Every mark as typed, all in `--f-mono` at 13/17 of the reader's size (line
numbers too), coloured per §2.6, with today's sentinel treatments (structural
band and hairline, rails joining explicit-close pairs, comment rules as
hairlines), scoped to `#editor[data-view="source"]`; Prose has its own (§8.1).

### 8.3 Text view (Aa), spelling, footer

Aa, per reader, not per book: face (Alegreya, Alegreya Sans, or the book's body
face), size (12–24, default 17), dim (off by default; paragraph or sentence),
page turns (on). Spelling stays its own menu. Built: the Aa popover is a
small-caps Face heading over three check items, each face named in itself, then
a hairline and rows of label left, control right: Size a − n + stepper, Dim a
seg, Page turns a switch. Dim fades the text outside the cursor's paragraph, or
outside its sentence, to opacity .28 over `--t` (instant under
`prefers-reduced-motion`), in both views; the margins, rubrics and notes stay,
and an illustration's image fades with its caption. A sentence ends at `.`, `?`
or `!` (and any closing quotes) before a space or the line's end, so an
abbreviation ends one early. Spelling's popover lists the word lists and None as
check items. Completions, the wrap bar, ⌘K, sentinel shortcuts, find and
replace, image drops and the preview following the cursor work in both views and
expanded. Footer (built): the writer's cell opens with "Chapter title · 41,210
words · +512 this session", the chapter at the cursor (its slug in `--f-hivis`
when it has no title; left out before the first chapter), the manuscript's words
and the words added since the book was opened (never below 0, in `--acc-ink`
once above it; words a reload from disk brings in don't count), recounted with
the parse; then Go to style. No goals or streaks. Typewriter scrolling and
writing on the book's paper were considered and dropped.

## 9. Winks

The label is always the plain word; the wink sits beside or behind it.

| Wink                    | Where                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| Small-caps group labels | style nav, outline, panel sections, menu headings                               |
| Red rubrics             | the Prose margin                                                                |
| Fell Great Primer       | view headings, dialog titles, empty states, the site                            |
| ☞ manicule              | notes in the margin; tip lines in the panel                                     |
| ⁂ asterism              | `{break}` in Prose                                                              |
| ❦ fleuron               | empty states; the site's feature heads and colophon                             |
| "Setting type… N pages" | pagination status (was "Rendering pages… N")                                    |
| Colophon                | About and the site footer: "Set in IM Fell Great Primer and Alegreya."          |
| Stet                    | tooltip on Keep my edits in the changed-on-disk banner: "stet: let it stand"    |
| Out of sorts            | lead word of a missing-glyph or missing-font warning (planned: none exists yet) |
| The sun mark            | §10                                                                             |

Out of scope unless asked: illustrations, woodcut empty states, blackletter.

## 10. The mark

The existing sun (`web/brand/mark.svg`), rays and disc, drawn in `--acc`: the
SVG sets its own `color` (`#db3834`, `#ef6d62` under
`prefers-color-scheme:
dark`), since an `<img>` or favicon cannot read the
page's tokens. The PNG icons (`icon-32`, `apple-touch-icon`, `icon-512`) are the
same sun in the light `--acc` on the manifest's cream `#f4efe4`, filling 81%,
86% and 62% of the square (the 512 leaves the maskable safe zone); re-export
them from `mark.svg` whenever the red changes.

The share card (`og.svg`, exported to `og.png` at 1200×630) is a black woodcut
title page rubricated in light `--acc`: the sun and the inner hairline rule are
red, the outer frame, hatching, stars and banner stay black. Re-export it with
the icons.

## 11. The hosted site

Same tokens, a louder register: headlines (`h1`) in Fell Great Primer at
2.875rem, one phrase in italic `--acc-ink` (`<em>`); body in Alegreya Sans
1.0625rem `--muted`, the lead 1.125rem; one large primary button ("Open the
editor", §6.1); section heads (`h2`) in Fell at `--fs-hero`; feature heads
(`.facts h3`) and the FAQ's questions in Fell at `--fs-h`, the feature heads
behind a ❦ in `--acc-ink`; the sun beside the wordmark "Wynkyn" in Fell at
`--fs-h`. The foot is a `--fs-xs` link line and the colophon, "Set in IM Fell
Great Primer and Alegreya.", in Alegreya italic behind the same red ❦. The site
pages have no `data-theme` and follow the system (`tokens.css`'s
`prefers-color-scheme` block); they link the same `web/tokens.css` as the app,
before `web/site/site.css`, which holds no tokens of its own.

## 12. Motion (planned)

`--t-fast` 120ms (hover, switch, chevrons), `--t` 200ms (pane expand, outline
slide, chrome fade); ease, no bounce. All of it instant under
`prefers-reduced-motion`.

## 13. Accessibility (default UI paper) (planned)

| Pair                        | Light | Dark |
| --------------------------- | ----- | ---- |
| `--fg` on `--bg`            | 16.5  | 15.3 |
| `--muted` on `--bg`         | 5.4   | 5.9  |
| `--muted` on `--desk`       | 4.7   | 6.5  |
| `--acc-ink` on `--bg`       | 5.5   | 9.0  |
| `--acc-ink` on `--acc-wash` | 4.9   | 6.4  |
| `--on-acc` on `--acc-btn`   | 5.7   | 7.1  |
| `--err` on `--bg`           | 7.0   | 7.7  |

`--acc` (bright) is 3.6:1 in light: marks, dots and fills only, never text.
Errors carry a word and icon. Focus is always visible. Hit targets ≥ 24px.
Everything scales with the browser's text size.

## 14. Moving from Ink (planned)

- **Tokens:** move them out of `web/app.css` into `web/tokens.css`, replacing
  Ink's `:root` blocks with the sheet's; rename Ink's `--paper` to `--stock`;
  retire ~~`--soft`~~, ~~`--inv-bg`~~, ~~`--inv-fg`~~, ~~`--syn-key`~~,
  ~~`--syn-slug`~~, ~~`--radius`~~, `--fs`/`--fs-sm` as px; `--pick` becomes
  minium.
- **Units:** convert every font size, padding, gap, height and radius in
  `app.css` (590 px values today) to the tokens; keep `1px`/`2px` for hairlines
  and rings. `web/design-tokens_test.ts` then holds the line: no `px` in
  `app.css` or `site.css` other than `1px` and `2px`.
- **Fonts:** vendor three families' woff2 under `vendor/fonts/` (Alegreya,
  Alegreya Sans, IM Fell Great Primer) with their OFL texts; monospace is the
  system's.
- **Components:** the wash replaces the black pill (§6.1, §6.7), including
  `toggle` buttons; fields, menus and dialogs per §6.
- **Skills:** `ink-design` is rewritten as `rubric-design` from this document
  (its "no coloured accents" rule is reversed); `ux-principles` gains "controls
  live with what they control" and drops Hide markup and the Pages toggle.
- **Spec** (`book-renderer-spec.md`): §7.1 (toolbar, pane headers, expand), §7.3
  (Prose / Source, Aa), §4.3 (`page.paper`), §7.6 (expanded pages).
- **Order:** tokens, fonts and units → components → toolbar, pane headers,
  expand → paper stock → Source restyle → Prose view → winks → site.

## 15. Open

- Whether the UI paper ever becomes a setting.
