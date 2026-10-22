# Page furniture: where folios and running heads go

## Drop rules (fixed, decided 2026-10-21)

The page map (`renderer/folios.js`, `PageEntry`) decides where furniture is
dropped, following Chicago:

- **Folio:** hidden on display pages (`pagedjs_display_page`: half title,
  title page, copyright, dedication, epigraph…) and on blank pages. Openers keep
  theirs.
- **Running head:** body zone only, and never on a display, blank or opener
  page. On a body page a running head that shares a margin box with a top folio
  wins (it is emitted after the folio); the panel's hint says so
  (`folioClash` in `web/src/panel-furniture.ts`).
- **Numbering:** front matter roman, body arabic from 1, back matter continues
  the body count. `refText` carries the number even where `folioText` is empty.

The Page furniture parts in the style panel show these as a read-only "Where
they're dropped" list. Decision: keep them read-only until a real book needs
an override. When one does, the likely shape is a per-part override (e.g.
Chapter opener → "Running head: show"), read by `folios.js` when it computes
`head` and `folioText`. The page map is the single source for folios, TOC
numbers and running heads, so an override there changes all three
consistently. Golden page maps (`testdata/*/page-map.json`) will move;
regenerate with `UPDATE_GOLDEN=1 deno task test` and read the diff.

## Anchoring to the text block

Paged.js makes each margin box exactly the size of its margin and centres
content in it, so a head would sit at half the top margin and drift as the
margin grows. The generator (`metadata/css-generator.ts`) anchors instead:
every bottom box gets `vertical-align: top` + `padding-top: <gap>`, every top
box `vertical-align: bottom` + `padding-bottom: <gap>`, emitted before user CSS
so a book's own keys still win. Defaults `DEFAULT_FOLIO_GAP = "5mm"`,
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
