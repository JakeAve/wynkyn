# Bug: justified last line on unsplit paragraphs (Paged.js `data-align-last-split-element` leak)

## Symptom

In the print preview, a paragraph that is NOT split across a page break can
still show its final line stretched full-width (word-spaced out), which is
normally reserved for a justified paragraph's line that continues past a page
break. First noticed on the Preface of `books/a-christmas-carol/manuscript.md` —
a single self-contained block on one page.

## Root cause

Paged.js's `Splits` handler (pagedjs 0.4.3, `dist/paged.js`, `Splits` handler
~lines 30197–30238; same code minified ~line 31348) runs on every
`afterPageLayout`. It collects every `[data-split-from]` element on the new
page, resolves each to its counterpart on the _previous_ page, and calls
`handleAlignment()` on the **deepest** such element. `handleAlignment` checks
only `getComputedStyle`: if `text-align` computes to `justify`, it stamps
`data-align-last-split-element="justify"` on that element, and Paged.js's own
injected stylesheet (line 27398) applies `text-align-last: justify` to it. There
is no check that the marked element is actually a paragraph, or that a paragraph
was genuinely fragmented mid-flow.

In this renderer, `renderer/base.css:22-26` puts `break-before: page` on every
`.matter` block. So the page after the Preface starts the next matter section.
On that new page, the elements carrying `data-split-from` are the _ancestor
containers_ that continue across the break — `.bml` and `.zone-front` (DOM
shape: `.bml > .zone.zone-front > .matter-preface > p`, see
`renderer/render.ts:375`) — not any paragraph. Paged.js marks the previous
page's deepest one (the `.zone-front` fragment containing the Preface) as
"split" and stamps the attribute on it.

`metadata.json` sets `text-align: justify` on `body` → `.bml`
(`metadata/css-generator.ts:15`), so the container computes `justify`, gets the
attribute, and `text-align-last: justify` **inherits down** into every intact
paragraph on the Preface's page — including the paragraph's true last line.

The existing partial fix at `renderer/base.css:84-89` only resets
`text-align-last: auto` on **direct children** of a marked element:

```css
.bml [data-align-last-split-element="justify"] > * {
  text-align-last: auto;
}
.bml [data-align-last-split-element="justify"] {
  text-align-last: justify;
}
```

That was written to stop the property leaking onto headings, but here the mark
lands several levels above the `<p>` (on the zone/container), so grandchildren
re-inherit anyway, and the second rule re-asserts justify on the marked ancestor
itself.

This is inherent Paged.js behavior — the `Splits` handler is unchanged upstream
for years — not a bug in this repo's own JS.

## Fix (applied 2026-08-29, `renderer/base.css`)

Replace `renderer/base.css:84-89` with a single rule that only honors the marker
when it lands on an actual paragraph:

```css
[data-align-last-split-element="justify"]:not(p) {
  text-align-last: auto;
}
```

Specificity (0,2,0) beats Paged.js's injected rule (0,1,0), so container
fragments (`.bml`, `.zone`, matter divs) stop leaking justify into intact
descendant paragraphs, while a paragraph that is genuinely split across a page
keeps its last-line-at-break justified via Paged.js's own rule. The old
descendant-reset rule becomes redundant (a container now computes `auto`, so
nothing inherits) and can be deleted.

## Verified (headless Chrome, a-christmas-carol, 120 pages)

- Preface (or any single-page `{matter:}` block) no longer shows a stretched
  last line.
- A paragraph that genuinely straddles a page break still gets its pre-break
  fragment's last line justified (no new raggedness introduced).

## Investigation credit

Diagnosed by a `fable`-model subagent tracing Paged.js's `Splits` handler source
directly (pagedjs 0.4.3) and confirming the DOM/CSS interaction in this repo.
