# BML — Book Markup Language
## A Semantic Plain-Text Notation for Hand-Bound Book Manuscripts
### Version 0.6 Draft

---

## 1. Philosophy

BML is a plain-text semantic markup language designed for book manuscripts, particularly for hand-bound and independently produced books. It separates **what something is** from **how it looks**. Font size, color, page dimensions, and typographic style are never expressed in BML. Those decisions belong to the rendering layer.

BML is:
- Human-readable without any tooling
- Renderer-agnostic
- Stable under reordering
- Purely semantic — no visual or layout information

BML is not:
- A typesetting language
- A replacement for InDesign, LaTeX, or similar tools
- A format for expressing design decisions

---

## 2. Core Syntax Rules

### 2.1 Comments

Lines beginning with `%%` are comments. They are stripped entirely from all output and never appear in the final product. Comments may appear anywhere in the document.

```
%%  This is a comment — never printed
%%  ─────────────────────────────────
%%  Use for notes, reminders, instructions to compositors
```

### 2.2 Sentinels

Sentinels are semantic markers enclosed in curly braces. They declare the nature of the content that follows. They never appear in the final output.

```
{sentinel}
{sentinel: slug}
{sentinel: slug | key: value | key: value}
```

The first colon separates the sentinel name from its slug. Pipes separate additional key-value pairs. Colons within a pair separate key from value. The slug is a special case of the first positional value — it has no key name.

### 2.3 Open and Closed Sentinels

Every sentinel takes one of four closing forms.

**Paragraph (implicit close)** — the sentinel applies to exactly one paragraph of content. No closing tag. The association ends at the next blank line or the next sentinel, whichever comes first. A paragraph is the unit here, not a physical line: content may wrap across several source lines (as in the `{rights}` example in §4.3) and remains one paragraph until a blank line or sentinel ends it.

```
{title}
The Orchard at the End of the Road
```

`{title}`, `{subtitle}`, `{author}`, `{dropcap}`, `{attribution}`, and similar component sentinels all close this way.

**Structural (nesting close)** — `{matter:}`, `{part:}`, and `{chapter:}` organize the document itself rather than marking a single piece of content, so they never take a closing tag at all — not even an implicit one at the next blank line. Instead, closing follows from BML's one structural nesting relationship: **a `{chapter:}` may nest inside a `{part:}`.** Nothing else nests inside anything else — `{matter:}` never contains a `{part:}` or `{chapter:}`, and a `{part:}` never contains another `{part:}`.

The rule: **opening a structural sentinel closes any currently-open structural sentinel, unless that open sentinel is a `{part:}` and the incoming one is a `{chapter:}`** (the one legal nesting case). Concretely:

- `{chapter:}` closes an open `{chapter:}` or `{matter:}`, but leaves an open `{part:}` untouched — the chapter nests inside it.
- `{part:}` closes an open `{part:}`, `{chapter:}`, or `{matter:}` — nothing can hold a part open across it.
- `{matter:}` closes an open `{matter:}`, `{part:}`, or `{chapter:}` — matter marks a new top-level zone (front matter, body matter, back matter), so nothing carries over into it.

A structural sentinel stays open — through paragraphs, blank lines, dropcaps, epigraphs, illustrations, and any other non-structural content — until one of its closers begins. This is the rule referenced throughout §§3–5 as "ends at the next \_\_\_."

**Block (explicit close)** — the sentinel wraps multiple paragraphs of non-structural content. A closing tag is required. Blank lines within the block are preserved.

```
{sidebar}
A note on apple varieties in this region.

They were primarily cultivated in the eastern valleys.
{/sidebar}
```

`{sidebar}`, `{pullquote}`, `{quote}`, `{poem}`, `{columns:}`, `{is:}`, `{verses:}`, and multi-paragraph `{epigraph}` all close this way.

**Inline (in-prose)** — the sentinel sits inside a line of prose rather than on a line of its own. Inline sentinels come in two kinds:

- **Wrapping** — encloses a span of text and requires a closing tag: `{em}the Queen Mary{/em}`. The span must open and close within the same paragraph.
- **Point** — marks a single position, has no content, and never takes a closing tag: `{footnote: slug}`, `{ref: slug}`.

See §2.7 for emphasis, §6.8 for footnotes, and §8 for cross-references.

**Rule:** structural sentinels (matter, part, chapter) never take a closing tag, under any circumstances. Block sentinels require the closing tag when the content spans more than one paragraph; for single-paragraph content the closing tag may be omitted. If no closing tag is present, the block ends at the next blank line or sentinel, exactly like an implicit close — a forgotten closing tag is not an error, but the content after the first paragraph falls outside the block (the same failure mode as an unclosed element in HTML).

**Nesting of blocks.** Three rules govern what may appear inside a block sentinel:

1. **Blocks nest properly.** A block opened inside another block must close before it — last opened, first closed. Overlapping blocks are not legal.
2. **No same-type direct nesting.** A `{sidebar}` may not contain a `{sidebar}`. `{is:}` blocks of *different* classes may nest, since each closing tag names its class.
3. **Structure trumps blocks.** Paragraph and inline sentinels may appear inside any block. Structural sentinels may not — an opening `{matter:}`, `{part:}`, or `{chapter:}`, or the end of the document, implicitly closes every open block.

```
{columns: 2}
{verses: psalm-19}
The heavens declare the glory of God;
and the firmament sheweth his handywork.
{/verses}
{/columns}
```

### 2.4 Slugs

A slug is a stable short identifier attached to a sentinel. It is used for navigation, cross-referencing, and tooling.

Slugs:
- Are lowercase only
- Use hyphens, not underscores
- Are drawn from the content where possible
- Are three words maximum
- Never appear in the final output
- Remain stable even if the associated title or content changes
- Are not required to be unique — the same slug may appear on multiple sentinels

Uniqueness is left to the author, and slugs deliberately blur the line between classes and ids. A recurring slug groups sentinels so they can be styled alike — `{is: handwritten-letter}` on every letter in the book. A one-off slug singles one out — `{is: handwritten-letter-charles}` for the letter that needs its own treatment. Cross-references (`{ref:}`) and footnote matching (`{footnote:}`/`{note:}`) are only reliable when the slug they point at is unique; when a slug is duplicated, tools resolve to the first matching occurrence.

```
{chapter: thaw}
{part: frost}
{illustration: orchard-1943}
```

### 2.5 Prose Content

All content not enclosed in sentinels and not beginning with `%%` is treated as manuscript prose and flows to the output. Blank lines between paragraphs are standard paragraph breaks.

### 2.6 Line Breaks

A hard line break within a paragraph — ending a line without starting a new paragraph — is marked with `\` at the end of the line.

```
{epigraph}
The water does not ask\
where it is going.
```

Use for poetry, addresses, epigraphs that span multiple lines, and any content where the line ending is part of the meaning.

### 2.7 Emphasis

`{em}` marks a span of prose as emphasized. It is a wrapping inline sentinel (§2.3): it sits inside the paragraph and requires a closing tag. Use it for stressed words, thoughts, foreign phrases, titles of works, ship names — anywhere the manuscript itself carries the distinction, whatever the renderer's visual treatment turns out to be (conventionally italics, but that is a rendering decision).

```
She had never seen the {em}Queen Mary{/em} at dock, and she
never would. {em}Never{/em}, she thought, was a long word.
```

An `{em}` span must open and close within the same paragraph.

### 2.8 Escapes

A backslash removes the markup meaning of what follows it. The backslash itself never appears in the output.

- `\{` — a literal opening brace in prose.
- `\` at the start of a line strips the markup meaning of the line's leading characters — use it when a line would otherwise be read as a list item or a comment: `\- not a list item`, `\1943. It was a hard year.`, `\%% not a comment`.
- `\\` at the end of a line — a literal backslash, not a hard line break (§2.6).

---

## 3. Document Structure

A BML document is divided into three implicit sections — front matter, body matter, and back matter — determined entirely by the sentinel types present. No section marker or comment header is required.

**Front matter** is the sequence of `{matter:}` blocks at the opening of the document (half-title, title-page, copyright, dedication, epigraph, toc, foreword, preface, introduction).

**Body matter** begins at the first `{part:}` or `{chapter:}` sentinel.

**Back matter** begins at the first `{matter:}` sentinel following body matter (appendix, bibliography, index, colophon).

A consequence, accepted deliberately: `{matter:}` blocks cannot appear in the middle of body matter. The first `{matter:}` after a `{part:}` or `{chapter:}` always begins back matter. Mid-book material — an interlude, a photo insert, a note between parts — should be expressed as a chapter or an `{is:}` block instead.

Authors may use decorative comments as visual landmarks in long manuscripts, but these carry no structural meaning.

---

## 4. Front Matter

Front matter pages are declared with `{matter: type}`. Each matter block contains sentinels for its semantic components. Content appears on the line immediately following its sentinel. Per the structural closing rule (§2.3), a matter block is closed by the next `{matter:}`, `{part:}`, or `{chapter:}` sentinel, whichever comes first.

### 4.1 Half-Title Page

The recto page preceding the full title page. Traditionally contains the title only, sometimes a series name.

```
{matter: half-title}
{title}
The Orchard at the End of the Road
```

### 4.2 Title Page

```
{matter: title-page}
{title}
The Orchard at the End of the Road
{subtitle}
A Novel
{author}
Jane Ellory
{publisher}
Thornfield Press
{publisher-location}
Edinburgh
{year}
2024
```

For multiple authors, repeat `{author}`:

```
{author}
Jane Ellory
{author}
Thomas Vane
```

For edited or translated works:

```
{editor}
Marcus Holt
{translator}
Sofia Bergmann
```

For series:

```
{series}
The Voronin Novels
{series-number}
2
```

### 4.3 Copyright Page

```
{matter: copyright}
{copyright-line}
© 2024 Jane Ellory
{edition}
First edition, 2024
{rights}
All rights reserved. No part of this publication may be reproduced
without prior written permission of the publisher.
{isbn}
978-0-000-00000-0
{printer}
Printed and bound by hand in Edinburgh
%%  Add CIP data here if seeking library distribution
```

### 4.4 Dedication

```
{matter: dedication}
For my father, who kept the trees.
```

### 4.5 Epigraph (Book-Level)

A quotation placed before the body of the book, distinct from chapter epigraphs.

```
{matter: epigraph}
{epigraph}
The orchard does not grieve the winter.
{attribution}
— Anna Voronin, 1932
```

### 4.6 Table of Contents

```
{matter: toc}
%%  auto-generated by renderer, or enter manually below
```

### 4.7 Foreword, Preface, Introduction

Prose sections. The section title uses the `{title}` sentinel; the flowing prose content follows.

```
{matter: foreword}
{title}
Foreword

{matter: preface}
{title}
Preface

{matter: introduction}
{title}
Introduction
```

---

## 5. Body Matter

### 5.1 Parts

A part groups multiple chapters under a common heading. The slug is the stable identifier. The title is given with the `{title}` sentinel; `{subtitle}` is available too. Rendering decides whether to number parts and in what style. Per the structural closing rule (§2.3), a part is closed by the next `{part:}` or `{matter:}` sentinel — a `{chapter:}` never closes it, since chapters nest inside parts.

```
{part: frost}
{title}
Before the Frost
```

Parts with a subtitle:

```
{part: frost}
{title}
Book One
{subtitle}
Before the Frost
```

### 5.2 Chapters

The slug is the stable identifier. The title is given with the `{title}` sentinel; `{subtitle}` is available too. Rendering decides whether to number chapters and in what style. Per the structural closing rule (§2.3), a chapter is closed by the next `{chapter:}`, `{part:}`, or `{matter:}` sentinel.

```
{chapter: thaw}
{title}
The First Thaw
```

Untitled chapters omit `{title}` entirely:

```
{chapter: crossing}
```

### 5.3 Headings

For titled sections within a chapter. A heading never opens a chapter or matter block — it subdivides the chapter it appears in. (Named sections like a Preface or Acknowledgements are matter blocks, not headings — see §4.7.) Two levels are available.

```
{chapter: letters}
{title}
The Letters

{heading}
Spring, 1943

{subheading}
The First Letter
```

A slug is optional:

```
{heading: spring-1943}
Spring, 1943
```

### 5.4 Drop Caps and Initials

Placed immediately before the opening paragraph of a chapter or section. Applies to the first letter of the following paragraph only.

```
{chapter: thaw}
{title}
The First Thaw

{dropcap}
The morning came slowly, the way mornings do in late February...
```

For an ornamental initial as an image rather than a typeset character:

```
{dropcap | image: initial-T}
The morning came slowly...
```

### 5.5 Epigraphs (Chapter-Level)

A quotation opening a chapter. Placed after the chapter title, before the first paragraph.

```
{chapter: river}
{title}
What the River Said

{epigraph}
The water does not ask where it is going.
{attribution}
— Old Voronin proverb

{dropcap}
It rained for six days after the funeral...
```

Multi-line epigraphs use the line break marker:

```
{epigraph}
The water does not ask\
where it is going.
{attribution}
— Old Voronin proverb
```

### 5.6 Breaks

`{break}` marks a deliberate discontinuity within a chapter without beginning a new chapter — a shift in time, location, point of view, or mood. A blank line alone is ambiguous and must not be used for breaks. The renderer decides the visual treatment — blank space, asterisks, an ornament, etc.

Bare `{break}` is the common case. An optional slug names a kind of break, so that different kinds can carry different treatments:

```
She did not look back at the house.

{break}

The train left at quarter past six.

{break: passage-of-years}

By the time the orchard bloomed again, the town had a new name.
```

### 5.7 Verses

Used for versed texts such as scripture. The sentinel declares the block; the parser assigns verse numbers automatically, one number per paragraph. The renderer decides how verse numbers are displayed.

```
{verses: genesis-1}
In the beginning God created the heaven and the earth.

And the earth was without form, and void; and darkness was
upon the face of the deep.

And God said, Let there be light: and there was light.
{/verses}
```

For passages that begin mid-chapter, declare the starting verse number:

```
{verses: genesis-1 | start: 3}
And God said, Let there be light: and there was light.
{/verses}
```

### 5.8 Poems

For poetry set within the text — a poem a character recites, song lyrics, an inscription in verse. Unlike `{verses:}`, nothing is numbered. Each paragraph is a stanza; line endings within a stanza use the line break marker (§2.6). An `{attribution}` may follow the poem.

```
{poem}
The apples fall\
in ordered rows.

The winter comes\
to count them all.
{/poem}
{attribution}
— from Anna's notebook
```

---

## 6. Special Blocks

### 6.1 Illustrations

The slug identifies the image file. The caption is manuscript content on the line following the sentinel. Placement is a metadata hint to the renderer.

```
{illustration: orchard-1943 | placement: full-page}
The Orchard, circa 1943

{illustration: portrait-anna | placement: inline}
Anna Voronin at the farm, undated

{illustration: map-district | placement: half-page}
The Voronin district, showing field boundaries
```

Valid placement values: `inline`, `half-page`, `full-page`, `full-spread`, `margin`

If no placement is specified, the renderer decides:

```
{illustration: orchard-1943}
The Orchard, circa 1943
```

### 6.2 Sidebars

```
{sidebar}
A brief aside that fits in one paragraph.

{sidebar}
A longer aside spanning multiple paragraphs.

The second paragraph continues here.
{/sidebar}
```

### 6.3 Pull Quotes

A pull quote repeats a phrase from the surrounding prose as a decorative element. The text also remains in the running prose; the renderer decides where and how the pulled copy is displayed.

```
{pullquote}
The orchard remembers what the house has forgotten.
```

### 6.4 Block Quotations

A quotation set off from the running prose — an extract from a letter, a cited passage, a recited speech. Unlike a pull quote, the quotation is part of the text, not a decorative repetition; unlike an epigraph, it may appear anywhere in the prose. An `{attribution}` may follow.

```
{quote}
We hold these truths to be self-evident, that all men are created equal.
{attribution}
— Declaration of Independence

{quote}
The first paragraph of a longer extract.

The second paragraph of the same extract.
{/quote}
```

### 6.5 Columns

Declares a section of content set across multiple columns. The column count is declared on the opening sentinel. `{col}` is optional, and its presence or absence determines which of two modes applies.

**Flow mode (default, no `{col}`)** — the content is a single stream of prose that the renderer reflows across the declared number of columns wherever it decides to break. This is the common case: a Bible or reference work set in two columns purely to fit more text per page, where there is no meaningful "break point" for a human to choose. The renderer decides all visual treatment — widths, gutters, and where the text divides.

```
{columns: 2}
A long passage of ordinary prose that should simply flow
across two columns on the page, wherever the renderer
decides to break it.
{/columns}
```

**Parallel mode (`{col}` present)** — the columns hold different, deliberately paired content — parallel translations, a text alongside its commentary — where only the author knows where one column's content ends and the next begins. `{col}` marks that boundary explicitly, and the renderer must not reflow across it.

```
{columns: 2}
The heavens declare the glory of God;
and the firmament sheweth his handywork.
{col}
Die Himmel erzählen die Ehre Gottes,
und die Feste verkündigt seiner Hände Werk.
{/columns}
```

Any positive integer is valid as the column count. In parallel mode, the number of `{col}` dividers within the block must be exactly one fewer than the declared count.

### 6.6 Custom Semantic Blocks

`{is}` wraps content with a user-defined semantic class. The class name is passed to the renderer, which maps it to appropriate styling. This is the extension point for content types that are structural and recurring but not covered by built-in sentinels — epistolary inserts, telegrams, newspaper clippings, diary entries, legal documents, and similar.

The class name follows slug conventions: lowercase, hyphenated, drawn from the content type.

```
{is: handwritten-letter}
My dearest friend,

I write to you from the shores of the Arctic, where the cold is a living thing.

Yours faithfully,
R. Walton
{/is: handwritten-letter}
```

The closing tag repeats the class name for readability. Single-paragraph blocks follow the standard implicit-close rule and do not require a closing tag.

Other sentinels may appear inside an `{is}` block:

```
{is: telegram}
{dropcap}
ARRIVED SAFELY STOP WIRE FUNDS TO EDINBURGH STOP
{/is: telegram}
```

### 6.7 Lists

Unordered and ordered lists use plain text notation. No sentinel is required.

```
- First item
- Second item
- Third item

1. Step one
2. Step two
3. Step three
```

A line that would be read as a list item but isn't one can be escaped with a leading `\` (§2.8).

### 6.8 Footnotes and Endnotes

The footnote anchor sits inline in the prose, immediately after the word or punctuation it attaches to, with no space. The note content lives separately with a matching slug. Whether notes render as footnotes or endnotes is a rendering decision. The anchor and its note may appear anywhere within the same structural block — the enclosing chapter or matter block — so front and back matter can carry notes too. The slug is the link between them.

```
The harvest that year was poor.{footnote: harvest-1943}

{note: harvest-1943}
Regional records show a 40% reduction in yield across the district.
```

---

## 7. Back Matter

```
{matter: appendix | label: A}
The Voronin Family Tree

{matter: appendix | label: B}
Glossary of Regional Terms

{matter: bibliography}
Bibliography

{matter: index}
%%  generated by tooling or entered manually

{matter: colophon}
{typeface}
Set in Garamond
{paper}
Printed on 80gsm cream stock
{binding}
Bound by hand in Edinburgh
{printer}
%%  Add printer name if applicable
```

---

## 8. Cross-References

Internal cross-references use the `{ref}` sentinel with the target slug. They never render literally — the renderer resolves them to a page number, chapter title, or other appropriate form.

```
As discussed in {ref: thaw}, the season had already turned.
%%  {ref} sentinels may also appear in comments for author navigation
```

---

## 9. Complete Tag Reference

### Structure Tags
| Tag | Closes | Description |
|---|---|---|
| `{part: slug}` | nesting close (§2.3) | Part divider; title via `{title}` (optional) |
| `{chapter: slug}` | nesting close (§2.3) | Chapter opener; title via `{title}` (optional) |
| `{heading}` or `{heading: slug}` | — | Section heading within a chapter; title on next line |
| `{subheading}` | — | Second-level heading within a chapter; title on next line |
| `{break}` or `{break: slug}` | — | Break within a chapter; optional slug names the kind |

### Matter Tags
| Tag | Closes | Description |
|---|---|---|
| `{matter: half-title}` | nesting close (§2.3) | Half-title page |
| `{matter: title-page}` | nesting close (§2.3) | Full title page |
| `{matter: copyright}` | nesting close (§2.3) | Copyright page |
| `{matter: dedication}` | nesting close (§2.3) | Dedication page |
| `{matter: epigraph}` | nesting close (§2.3) | Book-level epigraph page |
| `{matter: toc}` | nesting close (§2.3) | Table of contents |
| `{matter: foreword}` | nesting close (§2.3) | Foreword |
| `{matter: preface}` | nesting close (§2.3) | Preface |
| `{matter: introduction}` | nesting close (§2.3) | Introduction |
| `{matter: appendix \| label: X}` | nesting close (§2.3) | Appendix with label |
| `{matter: bibliography}` | nesting close (§2.3) | Bibliography |
| `{matter: index}` | nesting close (§2.3) | Index |
| `{matter: colophon}` | nesting close (§2.3) | Colophon |

### Title Tags
| Tag | Description |
|---|---|
| `{title}` | Title of the enclosing matter block, part, or chapter |
| `{subtitle}` | Subtitle of the enclosing matter block, part, or chapter |

### Title Page Component Tags
| Tag | Description |
|---|---|
| `{author}` | Author name; repeat for multiple authors |
| `{editor}` | Editor name |
| `{translator}` | Translator name |
| `{publisher}` | Publisher name |
| `{publisher-location}` | Publisher city |
| `{year}` | Publication year |
| `{edition}` | Edition statement |
| `{series}` | Series name |
| `{series-number}` | Volume number within series |
| `{copyright-line}` | Copyright notice |
| `{rights}` | Rights reservation text |
| `{isbn}` | ISBN |
| `{printer}` | Printer or binder credit |

### Body Tags
| Tag | Closes | Description |
|---|---|---|
| `{dropcap}` or `{dropcap \| image: slug}` | — | Drop cap on following paragraph |
| `{epigraph}` | `{/epigraph}` | Quotation; implicit close if single paragraph |
| `{quote}` | `{/quote}` | Block quotation; implicit close if single paragraph |
| `{attribution}` | — | Source of a quotation; binds to the immediately preceding epigraph, quote, poem, or pullquote |
| `{verses: slug}` or `{verses: slug \| start: n}` | `{/verses}` | Versed block; auto-numbered by paragraph |
| `{poem}` | `{/poem}` | Poem; each paragraph is a stanza, no numbering |

### Block Tags
| Tag | Closes | Description |
|---|---|---|
| `{illustration: slug}` or `{illustration: slug \| placement: value}` | — | Image placeholder; caption on next line |
| `{sidebar}` | `{/sidebar}` | Sidebar or inset text |
| `{pullquote}` | `{/pullquote}` | Pull quote |
| `{columns: n}` | `{/columns}` | Multi-column section; auto-flows unless `{col}` is present |
| `{col}` (optional) | — | Marks a manual column boundary; presence switches the block to parallel mode |
| `{is: class}` | `{/is: class}` | Custom semantic block; implicit close if single paragraph |

### Inline Tags
| Tag | Description |
|---|---|
| `{em}...{/em}` | Emphasized span; wrapping, must close within the paragraph |
| `{footnote: slug}` | Footnote anchor in prose; point marker, no closing tag |
| `{ref: slug}` | Cross-reference; point marker, renderer resolves to page or title |

### Note Tags
| Tag | Description |
|---|---|
| `{note: slug}` | Footnote or endnote content; matches footnote anchor |

### Colophon Component Tags
| Tag | Description |
|---|---|
| `{typeface}` | Typeface credit |
| `{paper}` | Paper stock description |
| `{binding}` | Binding method |

---

## 10. What BML Does Not Express

The following belong to the rendering or design layer and are explicitly outside BML's scope:

- Page break placement (all page boundaries are determined by the styling spec)
- Font family, size, weight, or style
- Color of any element
- Page dimensions or margins
- Running headers or footers
- Page numbers
- Leading, tracking, or kerning
- Column gutters or widths
- Image dimensions or resolution
- Chapter number style (Arabic, Roman, written out, suppressed)
- Break visual treatment (per break kind)
- Emphasis visual form (italic, small caps, letterspacing)
- Drop cap size or style
- Verse number display style
