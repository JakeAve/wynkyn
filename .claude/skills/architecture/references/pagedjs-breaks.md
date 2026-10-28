# Paged.js applies `page` and `break-*` by source order, not specificity

Paged.js 0.4.3's `Breaks` handler (`vendor/pagedjs/paged.js`, `class Breaks`)
strips every `page`, `break-before`, `break-after`, `page-break-before` and
`page-break-after` declaration from the stylesheets it processes. It keys
each one by its rule's selector text, then, once the content is parsed, walks
those keys in the order it first met them, runs `querySelectorAll` and writes
`data-page` / `data-break-before` / `data-break-after` on the matches. A
later write replaces an earlier one.

What follows:

- **Specificity does nothing for these properties.** The rule that comes last
  in the CSS wins. `base.css` is emitted before the book's own CSS, so a
  book's `chapter: { "break-before": "auto" }` beats base.css's
  `:where(.bml .chapter)` on order. Display matter's `page: display` beats
  `.zone-front { page: front }` because it comes later in base.css. The
  `:where()` wrappers on base.css's break rules matter only outside Paged.js.
- **Selectors are split on every comma, without parsing.** A comma inside
  `:is(a, b)` or `:where(a, b)` in a rule that carries one of these
  properties gives broken halves, and that rule silently stops applying. Write
  one `:where()` per selector, as base.css does.
- `break-before: page` is skipped where a named-page change already forces a
  break (`needsPageBreak`).

Verified by reading the handler and by checking the `data-break-*`
attributes on paginated pages (CSS audit, 2026-10-28).
