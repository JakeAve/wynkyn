# Page furniture: where folios and running heads go

## Drop rules (fixed, decided 2026-10-21)

The page map (`renderer/folios.js`, `PageEntry`) decides where furniture is
dropped, following Chicago:

- **Folio:** hidden on display pages (`pagedjs_display_page`: half title,
  title page, copyright, dedication, epigraph…) and on blank pages. Openers keep
  theirs unless `numbering.pages.openers` (the one override, added 2026-10-22
  for the Gatsby deco edition) drops it (`show: false`) or moves it
  (`position`): the page map then blanks `--folio` on the opener and writes the
  number to `--folio-opener`, which the generator reads at the override's
  boxes. `pageNumberingConfig` normalises a position equal to the book's to no
  override so both sides agree.
- **Running head:** body zone only, and never on a display, blank or opener
  page. On a body page a running head that shares a margin box with a top folio
  wins (it is emitted after the folio); the panel's hint says so
  (`folioClash` in `web/src/panel-furniture.ts`).
- **Numbering:** front matter roman, body arabic from 1, back matter continues
  the body count. `refText` carries the number even where `folioText` is empty.

The Page furniture parts in the style panel show the rest as a read-only
"Where they're dropped" list. Decision: keep them read-only until a real book
needs another override; the opener folio shows the shape (a key under
`numbering.pages`, read by `folios.js` when it computes `folioText`, and by
the generator for the boxes). The page map is the single source for folios,
TOC numbers and running heads, so an override there changes all three
consistently. Golden page maps (`testdata/*/page-map.json`) hold the digest
(zones, anchors, blanks), so a furniture override alone does not move them.

## Anchoring to the text block

Paged.js makes each margin box exactly the size of its margin and centres
content in it, so a head would sit at half the top margin and drift as the
margin grows. The generator (`metadata/css-generator.ts`) anchors instead:
every bottom box gets `vertical-align: top` + `padding-top: <gap>`, every top
box `vertical-align: bottom` + `padding-bottom: <gap>`, emitted
before user CSS so a book's own keys still win. `renderer/base.css` trims each
top/bottom box's line to cap height and baseline (`text-box: trim-both cap
alphabetic`), so the gap is clear space from the text block edge: to the
baseline of anything above it, to the cap height of anything below, and a
bigger size doesn't change it. Oldstyle figures overshoot slightly; a book
using them adds a millimetre. Defaults `DEFAULT_FOLIO_GAP = "5mm"`,
`DEFAULT_HEAD_GAP = "4mm"`; `numbering.pages.gap` and `running.gap` tune them.
Side boxes (`left-*`/`right-*`) are not anchored: the gap is a vertical
distance from the text block.

`numbering.pages.position` picks `bottom-center | bottom-outside | top-center |
top-outside`; "outside" maps to `-right` on `:right` pages and `-left` on
`:left`, and the display-page blanking covers whichever areas are in use.

## Styling

`numbering.pages.css` is shared by all three zones and merged under each
zone's own `css` (zone wins). Running entries resolve font aliases the same way
elements do. Margin boxes are outside `.bml`, so they inherit nothing from the
body: an unset font there is the browser default, and the font picker says so.
