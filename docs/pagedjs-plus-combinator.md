# Bug: Paged.js drops every rule with a `+` combinator

## Symptom

In the paginated preview and in `bml export`, paragraphs that should sit flush
were indented by the body's `text-indent`: every verse in a `{verses:}` block,
every poem stanza, every `{dropcap}` paragraph (so the first paragraph of every
chapter in every book), and every paragraph inside a `{quote}`/`{epigraph}`.

None of it reproduced in a plain browser render of the same HTML and CSS — only
after Paged.js had paginated.

## Root cause

base.css collapsed six selectors into one rule:

```css
.bml p.has-dropcap,
.bml h1 + p,
.bml .break + p,
.bml blockquote p,
.bml .stanza,
.bml .verse {
  text-indent: 0;
}
```

Paged.js 0.4.3 re-parses and re-emits every stylesheet it processes, and its
parser discards any rule whose selector contains an adjacent-sibling `+`
combinator — **the entire rule, not just the offending selector**. Two `+`
selectors in that list therefore deleted the other four as collateral, and
`.bml p { text-indent: 1.5em }` was left to win by default.

Verified against `books/first-nephi` at pagedjs 0.4.3 by diffing
`document.styleSheets` before and after pagination. `h1+p` (unspaced), `h1 + p`,
and `:is(h1 + p)` are all dropped; `~` and `>` survive.

## Fix

`renderer/base.css` contains no `+` combinator, and `renderer/base-css_test.ts`
fails if one is reintroduced. The two rules that needed sibling matching are now
a class: `renderChildren()` in `renderer/render.ts` marks a paragraph that
directly follows a `{title}` or a `{break}` with `class="lead"`, and base.css
styles `.bml p.lead`.
