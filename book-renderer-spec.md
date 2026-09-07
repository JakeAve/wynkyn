# Book Markup & Renderer — Master Specification and Build Plan

**Status:** Draft v1 — single source of truth for a fresh repository. This
document is self-contained: a reader with no prior context on this project
should be able to build the whole system from it.

---

## 0. Vision

A completely web-based book editing and printing application for hand-bound and
independently produced books. A user takes a plain manuscript and marks it up in
**BML** (Book Markup Language, specified in full in §3) — a plain-text,
semantic, renderer-agnostic notation. The application then:

1. Lets the user edit BML in a browser, with live syntax awareness and a project
   tree reflecting document structure.
2. Renders a live, print-accurate preview — odd/even page spreads exactly as
   they will appear on paper, accounting for trim size, margins, page numbers,
   running headers, columns, verses, table of contents, and every other
   layout-affecting feature.
3. Lets the user style every sentinel (semantic markup element) with a CSS-like
   cascading system — by type, by slug, by sibling position — without leaving
   the browser or hand-editing JSON.
4. Produces a final, print-ready, imposed output: pages arranged onto physical
   sheets according to a chosen signature size (folios per signature), ready to
   be printed, cut, folded, and hand-bound.

Two concerns are permanently separated, by design of BML itself: **what the
content is** (BML, semantic) and **how it looks** (metadata.json + the styling
UI, presentational). Nothing in BML ever expresses a font, color, size, or page
break.

---

## 1. Repository Structure

This is a fresh repository, built entirely from this specification. Nothing is
carried over from any prior codebase. Deno is the runtime for the whole backend.
Target module layout:

```
parser/
  types.ts            — BmlDocument tree types (see §5.1)
  parser.ts           — parse(source: string): BmlDocument
  parser_test.ts       — unit tests covering the full BML grammar, one case per construct in §3

metadata/
  types.ts            — Metadata schema types (see §4)
  loader.ts           — loadMetadata(bookDir): Promise<Metadata | null>
  css-generator.ts     — generatePagedCSS / generateDomCSS / generateFontLinks (see §5.2)
  css-generator_test.ts

renderer/
  render.ts            — render(doc: BmlDocument, opts): string (BML tree → HTML)
  base.css             — base structural CSS (page box, typography resets), independent of any book's metadata.json

server/
  dev-server.ts        — Deno live dev server: watches manuscript.md/metadata.json, re-renders, pushes updates over a WebSocket (see §6)
  print-export.ts      — imposes the paginated book onto physical sheets and produces the print-ready file (see §7.7)

web/
  ...                  — browser app: project tree, CodeMirror editor, preview pane, configuration panels (see §7)

books/
  common-sense/
    manuscript.md        — full BML source
    metadata.json        — full styling config
    images/              — image files referenced by {illustration:} and {dropcap | image:} slugs
  great-gatsby/
    manuscript.md
    metadata.json
    images/
```

Two validation books (`common-sense`, `great-gatsby`) are authored as part of
Plan 0 (§9) specifically to exercise the full BML grammar and metadata schema
end to end — they are test fixtures as much as they are content.

---

## 2. Workflow

A user takes a plain manuscript and manually converts it into a BML-compliant
document (§3). The user previews their book layout identical to how it will
appear in print. Once the document is ready, the user prints using a specified
number of folios per signature. The "sheet" and "page" are not necessarily 1:1 —
how many book pages fit on each sheet side is derived from the sheet and
book-page dimensions (§7.7). A 3.5in-wide book page on US Legal prints 4-up (8
book pages per duplex sheet); a 5.5in-wide page on the same sheet prints 2-up (4
book pages per sheet). All folds are vertical, parallel to the spine: a 2-up
sheet is folded once at its center, while a 4-up sheet is first cut at its
vertical center and each half is then folded. Every folded piece is a **folio**
— 2 leaves, 4 book pages — and folios nest inside one another to form
signatures. This is the only binding style in scope for v1 (see §8, Non-Goals).

---

## 3. The BML Language Specification (v0.6)

### 3.1 Philosophy

BML is a plain-text semantic markup language designed for book manuscripts,
particularly for hand-bound and independently produced books. It separates
**what something is** from **how it looks**. Font size, color, page dimensions,
and typographic style are never expressed in BML. Those decisions belong to the
rendering layer.

BML is:

- Human-readable without any tooling
- Renderer-agnostic
- Stable under reordering
- Purely semantic — no visual or layout information

BML is not:

- A typesetting language
- A replacement for InDesign, LaTeX, or similar tools
- A format for expressing design decisions

### 3.2 Core Syntax Rules

#### 3.2.1 Comments

Lines beginning with `%%` are comments. They are stripped entirely from all
output and never appear in the final product. Comments may appear anywhere in
the document.

```
%%  This is a comment — never printed
%%  ─────────────────────────────────
%%  Use for notes, reminders, instructions to compositors
```

#### 3.2.2 Sentinels

Sentinels are semantic markers enclosed in curly braces. They declare the nature
of the content that follows. They never appear in the final output.

```
{sentinel}
{sentinel: slug}
{sentinel: slug | key: value | key: value}
```

The first colon separates the sentinel name from its slug. Pipes separate
additional key-value pairs. Colons within a pair separate key from value. The
slug is a special case of the first positional value — it has no key name.

#### 3.2.3 Open and Closed Sentinels

Every sentinel takes one of four closing forms.

**Paragraph (implicit close)** — the sentinel applies to exactly one paragraph
of content. No closing tag. The association ends at the next blank line or the
next sentinel, whichever comes first. A paragraph is the unit here, not a
physical line: content may wrap across several source lines (as in the
`{rights}` example in §3.4.3) and remains one paragraph until a blank line or
sentinel ends it.

```
{title}
The Orchard at the End of the Road
```

`{title}`, `{subtitle}`, `{author}`, `{dropcap}`, `{attribution}`, and similar
component sentinels all close this way.

**Structural (nesting close)** — `{matter:}`, `{part:}`, and `{chapter:}`
organize the document itself rather than marking a single piece of content, so
they never take a closing tag at all — not even an implicit one at the next
blank line. Instead, closing follows from BML's one structural nesting
relationship: **a `{chapter:}` may nest inside a `{part:}`.** Nothing else nests
inside anything else — `{matter:}` never contains a `{part:}` or `{chapter:}`,
and a `{part:}` never contains another `{part:}`.

The rule: **opening a structural sentinel closes any currently-open structural
sentinel, unless that open sentinel is a `{part:}` and the incoming one is a
`{chapter:}`** (the one legal nesting case). Concretely:

- `{chapter:}` closes an open `{chapter:}` or `{matter:}`, but leaves an open
  `{part:}` untouched — the chapter nests inside it.
- `{part:}` closes an open `{part:}`, `{chapter:}`, or `{matter:}` — nothing can
  hold a part open across it.
- `{matter:}` closes an open `{matter:}`, `{part:}`, or `{chapter:}` — matter
  marks a new top-level zone (front matter, body matter, back matter), so
  nothing carries over into it.

A structural sentinel stays open — through paragraphs, blank lines, dropcaps,
epigraphs, illustrations, and any other non-structural content — until one of
its closers begins. This is the rule referenced throughout §§3.4–3.6 as "ends at
the next \_\_\_."

**Block (explicit close)** — the sentinel wraps multiple paragraphs of
non-structural content. A closing tag is required. Blank lines within the block
are preserved.

```
{sidebar}
A note on apple varieties in this region.

They were primarily cultivated in the eastern valleys.
{/sidebar}
```

`{sidebar}`, `{pullquote}`, `{quote}`, `{poem}`, `{columns:}`, `{is:}`,
`{verses:}`, and multi-paragraph `{epigraph}` all close this way.

**Inline (in-prose)** — the sentinel sits inside a line of prose rather than on
a line of its own. Inline sentinels come in two kinds:

- **Wrapping** — encloses a span of text and requires a closing tag:
  `{em}the Queen Mary{/em}`. The span must open and close within the same
  paragraph.
- **Point** — marks a single position, has no content, and never takes a closing
  tag: `{footnote: slug}`, `{ref: slug}`.

See §3.2.7 for emphasis, §3.6.8 for footnotes, and §3.7 for cross-references.

**Rule:** structural sentinels (matter, part, chapter) never take a closing tag,
under any circumstances. Block sentinels require the closing tag when the
content spans more than one paragraph; for single-paragraph content the closing
tag may be omitted. If no closing tag is present, the block ends at the next
blank line or sentinel, exactly like an implicit close — a forgotten closing tag
is not an error, but the content after the first paragraph falls outside the
block (the same failure mode as an unclosed element in HTML).

**Nesting of blocks.** Three rules govern what may appear inside a block
sentinel:

1. **Blocks nest properly.** A block opened inside another block must close
   before it — last opened, first closed. Overlapping blocks are not legal.
2. **No same-type direct nesting.** A `{sidebar}` may not contain a `{sidebar}`.
   `{is:}` blocks of _different_ classes may nest, since each closing tag names
   its class.
3. **Structure trumps blocks.** Paragraph and inline sentinels may appear inside
   any block. Structural sentinels may not — an opening `{matter:}`, `{part:}`,
   or `{chapter:}`, or the end of the document, implicitly closes every open
   block.

```
{columns: 2}
{verses: psalm-19}
The heavens declare the glory of God;
and the firmament sheweth his handywork.
{/verses}
{/columns}
```

#### 3.2.4 Slugs

A slug is a stable short identifier attached to a sentinel. It is used for
navigation, cross-referencing, and tooling.

Slugs:

- Are lowercase only
- Use hyphens, not underscores
- Are drawn from the content where possible
- Are three words maximum
- Never appear in the final output
- Remain stable even if the associated title or content changes
- Are not required to be unique — the same slug may appear on multiple sentinels

Uniqueness is left to the author, and slugs deliberately blur the line between
classes and ids. A recurring slug groups sentinels so they can be styled alike —
`{is: handwritten-letter}` on every letter in the book. A one-off slug singles
one out — `{is: handwritten-letter-charles}` for the letter that needs its own
treatment. Cross-references (`{ref:}`) and footnote matching
(`{footnote:}`/`{note:}`) are only reliable when the slug they point at is
unique; when a slug is duplicated, tools resolve to the first matching
occurrence.

```
{chapter: thaw}
{part: frost}
{illustration: orchard-1943}
```

#### 3.2.5 Prose Content

All content not enclosed in sentinels and not beginning with `%%` is treated as
manuscript prose and flows to the output. Blank lines between paragraphs are
standard paragraph breaks.

#### 3.2.6 Line Breaks

A hard line break within a paragraph — ending a line without starting a new
paragraph — is marked with `\` at the end of the line.

```
{epigraph}
The water does not ask\
where it is going.
```

Use for poetry, addresses, epigraphs that span multiple lines, and any content
where the line ending is part of the meaning.

#### 3.2.7 Emphasis

`{em}` marks a span of prose as emphasized. It is a wrapping inline sentinel
(§3.2.3): it sits inside the paragraph and requires a closing tag. Use it for
stressed words, thoughts, foreign phrases, titles of works, ship names —
anywhere the manuscript itself carries the distinction, whatever the renderer's
visual treatment turns out to be (conventionally italics, but that is a
rendering decision).

```
She had never seen the {em}Queen Mary{/em} at dock, and she
never would. {em}Never{/em}, she thought, was a long word.
```

An `{em}` span must open and close within the same paragraph.

#### 3.2.8 Escapes

A backslash removes the markup meaning of what follows it. The backslash itself
never appears in the output.

- `\{` — a literal opening brace in prose.
- `\` at the start of a line strips the markup meaning of the line's leading
  characters — use it when a line would otherwise be read as a list item or a
  comment: `\- not a list item`, `\1943. It was a hard year.`,
  `\%% not a comment`.
- `\\` at the end of a line — a literal backslash, not a hard line break
  (§3.2.6).

### 3.3 Document Structure

A BML document is divided into three implicit sections — front matter, body
matter, and back matter — determined entirely by the sentinel types present. No
section marker or comment header is required.

**Front matter** is the sequence of `{matter:}` blocks at the opening of the
document (half-title, title-page, copyright, dedication, epigraph, toc,
foreword, preface, introduction).

**Body matter** begins at the first `{part:}` or `{chapter:}` sentinel.

**Back matter** begins at the first `{matter:}` sentinel following body matter
(appendix, bibliography, index, colophon).

A consequence, accepted deliberately: `{matter:}` blocks cannot appear in the
middle of body matter. The first `{matter:}` after a `{part:}` or `{chapter:}`
always begins back matter. Mid-book material — an interlude, a photo insert, a
note between parts — should be expressed as a chapter or an `{is:}` block
instead.

Authors may use decorative comments as visual landmarks in long manuscripts, but
these carry no structural meaning.

### 3.4 Front Matter

Front matter pages are declared with `{matter: type}`. Each matter block
contains sentinels for its semantic components. Content appears on the line
immediately following its sentinel. Per the structural closing rule (§3.2.3), a
matter block is closed by the next `{matter:}`, `{part:}`, or `{chapter:}`
sentinel, whichever comes first.

#### 3.4.1 Half-Title Page

The recto page preceding the full title page. Traditionally contains the title
only, sometimes a series name.

```
{matter: half-title}
{title}
The Orchard at the End of the Road
```

#### 3.4.2 Title Page

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

#### 3.4.3 Copyright Page

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

#### 3.4.4 Dedication

```
{matter: dedication}
For my father, who kept the trees.
```

#### 3.4.5 Epigraph (Book-Level)

A quotation placed before the body of the book, distinct from chapter epigraphs.

```
{matter: epigraph}
{epigraph}
The orchard does not grieve the winter.
{attribution}
— Anna Voronin, 1932
```

#### 3.4.6 Table of Contents

```
{matter: toc}
{title}
Contents
```

When the block holds nothing but a `{title}`, the renderer generates the
contents from the document tree (§4.11 item 10): front matter that has a
`{title}` (except the display pages — half-title, title page, copyright,
dedication, epigraph, and the contents itself), every part and chapter with its
number when `numbering` shows one and its `{subtitle}` if present, level-1
headings that carry a slug when metadata `toc.headings` is `true` (§4.12), and
back matter that has a `{title}`. An untitled chapter lists as its number alone,
or its slug if numbers are off. Page numbers come from `target-counter()`;
front- and back-matter rows use their zone's page-number style (§4.7), so a
preface shows `v`.

Any prose inside the block replaces the generated list and is rendered verbatim
— the manual fallback for one-off layouts.

#### 3.4.7 Foreword, Preface, Introduction

Prose sections. The section title uses the `{title}` sentinel; the flowing prose
content follows.

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

### 3.5 Body Matter

#### 3.5.1 Parts

A part groups multiple chapters under a common heading. The slug is the stable
identifier. The title is given with the `{title}` sentinel; `{subtitle}` is
available too. Rendering decides whether to number parts and in what style. Per
the structural closing rule (§3.2.3), a part is closed by the next `{part:}` or
`{matter:}` sentinel — a `{chapter:}` never closes it, since chapters nest
inside parts.

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

#### 3.5.2 Chapters

The slug is the stable identifier. The title is given with the `{title}`
sentinel; `{subtitle}` is available too. Rendering decides whether to number
chapters and in what style. Per the structural closing rule (§3.2.3), a chapter
is closed by the next `{chapter:}`, `{part:}`, or `{matter:}` sentinel.

```
{chapter: thaw}
{title}
The First Thaw
```

Untitled chapters omit `{title}` entirely:

```
{chapter: crossing}
```

#### 3.5.3 Headings

For titled sections within a chapter. A heading never opens a chapter or matter
block — it subdivides the chapter it appears in. (Named sections like a Preface
or Acknowledgements are matter blocks, not headings — see §3.4.7.) Two levels
are available.

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

#### 3.5.4 Drop Caps and Initials

Placed immediately before the opening paragraph of a chapter or section. Applies
to the first letter of the following paragraph only.

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

#### 3.5.5 Epigraphs (Chapter-Level)

A quotation opening a chapter. Placed after the chapter title, before the first
paragraph.

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

#### 3.5.6 Breaks

`{break}` marks a deliberate discontinuity within a chapter without beginning a
new chapter — a shift in time, location, point of view, or mood. A blank line
alone is ambiguous and must not be used for breaks. The renderer decides the
visual treatment — blank space, asterisks, an ornament, etc.

Bare `{break}` is the common case. An optional slug names a kind of break, so
that different kinds can carry different treatments:

```
She did not look back at the house.

{break}

The train left at quarter past six.

{break: passage-of-years}

By the time the orchard bloomed again, the town had a new name.
```

#### 3.5.7 Verses

Used for versed texts such as scripture. The sentinel declares the block; the
parser assigns verse numbers automatically, one number per paragraph. The
renderer decides how verse numbers are displayed.

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

A `{dropcap}` may open a verse, for an illuminated initial on the first verse of
a chapter; the verse keeps its number.

#### 3.5.8 Poems

For poetry set within the text — a poem a character recites, song lyrics, an
inscription in verse. Unlike `{verses:}`, nothing is numbered. Each paragraph is
a stanza; line endings within a stanza use the line break marker (§3.2.6). An
`{attribution}` may follow the poem.

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

### 3.6 Special Blocks

#### 3.6.1 Illustrations

The slug identifies the image file. The caption is manuscript content on the
line following the sentinel. Placement is a metadata hint to the renderer.

```
{illustration: orchard-1943 | placement: full-page}
The Orchard, circa 1943

{illustration: portrait-anna | placement: inline}
Anna Voronin at the farm, undated

{illustration: map-district | placement: half-page}
The Voronin district, showing field boundaries
```

Valid placement values: `inline`, `half-page`, `full-page`, `full-spread`,
`margin`

If no placement is specified, the renderer decides:

```
{illustration: orchard-1943}
The Orchard, circa 1943
```

#### 3.6.2 Sidebars

```
{sidebar}
A brief aside that fits in one paragraph.

{sidebar}
A longer aside spanning multiple paragraphs.

The second paragraph continues here.
{/sidebar}
```

#### 3.6.3 Pull Quotes

A pull quote repeats a phrase from the surrounding prose as a decorative
element. The text also remains in the running prose; the renderer decides where
and how the pulled copy is displayed.

```
{pullquote}
The orchard remembers what the house has forgotten.
```

#### 3.6.4 Block Quotations

A quotation set off from the running prose — an extract from a letter, a cited
passage, a recited speech. Unlike a pull quote, the quotation is part of the
text, not a decorative repetition; unlike an epigraph, it may appear anywhere in
the prose. An `{attribution}` may follow.

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

#### 3.6.5 Columns

Declares a section of content set across multiple columns. The column count is
declared on the opening sentinel. `{col}` is optional, and its presence or
absence determines which of two modes applies.

**Flow mode (default, no `{col}`)** — the content is a single stream of prose
that the renderer reflows across the declared number of columns wherever it
decides to break. This is the common case: a Bible or reference work set in two
columns purely to fit more text per page, where there is no meaningful "break
point" for a human to choose. The renderer decides all visual treatment —
widths, gutters, and where the text divides.

```
{columns: 2}
A long passage of ordinary prose that should simply flow
across two columns on the page, wherever the renderer
decides to break it.
{/columns}
```

**Parallel mode (`{col}` present)** — the columns hold different, deliberately
paired content — parallel translations, a text alongside its commentary — where
only the author knows where one column's content ends and the next begins.
`{col}` marks that boundary explicitly, and the renderer must not reflow across
it.

```
{columns: 2}
The heavens declare the glory of God;
and the firmament sheweth his handywork.
{col}
Die Himmel erzählen die Ehre Gottes,
und die Feste verkündigt seiner Hände Werk.
{/columns}
```

Any positive integer is valid as the column count. In parallel mode, the number
of `{col}` dividers within the block must be exactly one fewer than the declared
count.

#### 3.6.6 Custom Semantic Blocks

`{is}` wraps content with a user-defined semantic class. The class name is
passed to the renderer, which maps it to appropriate styling. This is the
extension point for content types that are structural and recurring but not
covered by built-in sentinels — epistolary inserts, telegrams, newspaper
clippings, diary entries, legal documents, and similar.

The class name follows slug conventions: lowercase, hyphenated, drawn from the
content type.

```
{is: handwritten-letter}
My dearest friend,

I write to you from the shores of the Arctic, where the cold is a living thing.

Yours faithfully,
R. Walton
{/is: handwritten-letter}
```

The closing tag repeats the class name for readability. Single-paragraph blocks
follow the standard implicit-close rule and do not require a closing tag.

Other sentinels may appear inside an `{is}` block:

```
{is: telegram}
{dropcap}
ARRIVED SAFELY STOP WIRE FUNDS TO EDINBURGH STOP
{/is: telegram}
```

#### 3.6.7 Lists

Unordered and ordered lists use plain text notation. No sentinel is required.

```
- First item
- Second item
- Third item

1. Step one
2. Step two
3. Step three
```

A line that would be read as a list item but isn't one can be escaped with a
leading `\` (§3.2.8).

#### 3.6.8 Footnotes and Endnotes

The footnote anchor sits inline in the prose, immediately after the word or
punctuation it attaches to, with no space. The note content lives separately
with a matching slug. Whether notes render as footnotes or endnotes is a
rendering decision (configured in `metadata.json`, §4.10). The anchor and its
note may appear anywhere within the same structural block — the enclosing
chapter or matter block — so front and back matter can carry notes too. The slug
is the link between them.

```
The harvest that year was poor.{footnote: harvest-1943}

{note: harvest-1943}
Regional records show a 40% reduction in yield across the district.
```

### 3.7 Back Matter

```
{matter: appendix | label: A}
{title}
The Voronin Family Tree

{matter: appendix | label: B}
{title}
Glossary of Regional Terms

{matter: bibliography}
{title}
Bibliography

{matter: index}
{title}
Index

%%  entries generated by tooling or entered manually

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

Every back-matter section that carries a heading names it with `{title}`,
exactly as prose front matter does (§3.4.7) — the generated contents lists only
matter blocks that have one (§3.4.6), so a section written without it silently
disappears from the contents. The colophon is the exception: it is built from
components (§3.8) and carries no heading, and is not listed. `bml check` reports
a matter block that is missing a `{title}` it needs.

### 3.8 Cross-References

Internal cross-references use the `{ref}` sentinel with the target slug. They
never render literally — the renderer resolves them to a page number, chapter
title, or other appropriate form.

```
As discussed in {ref: thaw}, the season had already turned.
%%  {ref} sentinels may also appear in comments for author navigation
```

### 3.9 Complete Tag Reference

**Structure Tags**

| Tag                              | Closes                 | Description                                               |
| -------------------------------- | ---------------------- | --------------------------------------------------------- |
| `{part: slug}`                   | nesting close (§3.2.3) | Part divider; title via `{title}` (optional)              |
| `{chapter: slug}`                | nesting close (§3.2.3) | Chapter opener; title via `{title}` (optional)            |
| `{heading}` or `{heading: slug}` | —                      | Section heading within a chapter; title on next line      |
| `{subheading}`                   | —                      | Second-level heading within a chapter; title on next line |
| `{break}` or `{break: slug}`     | —                      | Break within a chapter; optional slug names the kind      |

**Matter Tags**

| Tag                              | Closes                 | Description              |
| -------------------------------- | ---------------------- | ------------------------ |
| `{matter: half-title}`           | nesting close (§3.2.3) | Half-title page          |
| `{matter: title-page}`           | nesting close (§3.2.3) | Full title page          |
| `{matter: copyright}`            | nesting close (§3.2.3) | Copyright page           |
| `{matter: dedication}`           | nesting close (§3.2.3) | Dedication page          |
| `{matter: epigraph}`             | nesting close (§3.2.3) | Book-level epigraph page |
| `{matter: toc}`                  | nesting close (§3.2.3) | Table of contents        |
| `{matter: foreword}`             | nesting close (§3.2.3) | Foreword                 |
| `{matter: preface}`              | nesting close (§3.2.3) | Preface                  |
| `{matter: introduction}`         | nesting close (§3.2.3) | Introduction             |
| `{matter: appendix \| label: X}` | nesting close (§3.2.3) | Appendix with label      |
| `{matter: bibliography}`         | nesting close (§3.2.3) | Bibliography             |
| `{matter: index}`                | nesting close (§3.2.3) | Index                    |
| `{matter: colophon}`             | nesting close (§3.2.3) | Colophon                 |

**Title Tags**

| Tag          | Description                                              |
| ------------ | -------------------------------------------------------- |
| `{title}`    | Title of the enclosing matter block, part, or chapter    |
| `{subtitle}` | Subtitle of the enclosing matter block, part, or chapter |

**Title Page Component Tags**

| Tag                    | Description                              |
| ---------------------- | ---------------------------------------- |
| `{author}`             | Author name; repeat for multiple authors |
| `{editor}`             | Editor name                              |
| `{translator}`         | Translator name                          |
| `{publisher}`          | Publisher name                           |
| `{publisher-location}` | Publisher city                           |
| `{year}`               | Publication year                         |
| `{edition}`            | Edition statement                        |
| `{series}`             | Series name                              |
| `{series-number}`      | Volume number within series              |
| `{copyright-line}`     | Copyright notice                         |
| `{rights}`             | Rights reservation text                  |
| `{isbn}`               | ISBN                                     |
| `{printer}`            | Printer or binder credit                 |

**Body Tags**

| Tag                                              | Closes        | Description                                                                                   |
| ------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------- |
| `{dropcap}` or `{dropcap \| image: slug}`        | —             | Drop cap on following paragraph                                                               |
| `{epigraph}`                                     | `{/epigraph}` | Quotation; implicit close if single paragraph                                                 |
| `{quote}`                                        | `{/quote}`    | Block quotation; implicit close if single paragraph                                           |
| `{attribution}`                                  | —             | Source of a quotation; binds to the immediately preceding epigraph, quote, poem, or pullquote |
| `{verses: slug}` or `{verses: slug \| start: n}` | `{/verses}`   | Versed block; auto-numbered by paragraph                                                      |
| `{poem}`                                         | `{/poem}`     | Poem; each paragraph is a stanza, no numbering                                                |

**Block Tags**

| Tag                                                                  | Closes         | Description                                                                  |
| -------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| `{illustration: slug}` or `{illustration: slug \| placement: value}` | —              | Image placeholder; caption on next line                                      |
| `{sidebar}`                                                          | `{/sidebar}`   | Sidebar or inset text                                                        |
| `{pullquote}`                                                        | `{/pullquote}` | Pull quote                                                                   |
| `{columns: n}`                                                       | `{/columns}`   | Multi-column section; auto-flows unless `{col}` is present                   |
| `{col}` (optional)                                                   | —              | Marks a manual column boundary; presence switches the block to parallel mode |
| `{is: class}`                                                        | `{/is: class}` | Custom semantic block; implicit close if single paragraph                    |

**Inline Tags**

| Tag                | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `{em}...{/em}`     | Emphasized span; wrapping, must close within the paragraph        |
| `{footnote: slug}` | Footnote anchor in prose; point marker, no closing tag            |
| `{ref: slug}`      | Cross-reference; point marker, renderer resolves to page or title |

**Note Tags**

| Tag            | Description                                          |
| -------------- | ---------------------------------------------------- |
| `{note: slug}` | Footnote or endnote content; matches footnote anchor |

**Colophon Component Tags**

| Tag          | Description             |
| ------------ | ----------------------- |
| `{typeface}` | Typeface credit         |
| `{paper}`    | Paper stock description |
| `{binding}`  | Binding method          |

### 3.10 What BML Does Not Express

The following belong to the rendering or design layer and are explicitly outside
BML's scope:

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

---

## 4. Metadata Schema (`metadata.json`)

Each book lives in its own directory alongside a `manuscript.md` (BML source)
and a `metadata.json` (design configuration). The metadata file is fully
self-contained — no inheritance from a global default. It controls page
dimensions, fonts, per-element typography, custom `{is:}` block styles,
numbering, and running headers.

The schema is CSS-centric: property names and values match CSS directly wherever
possible, so there is no translation layer between what you write and what the
renderer emits. The two exceptions are `numbering` (semantic style names like
`"roman-upper"`) and `running` content values (like `"chapter-title"`), where
CSS has no direct equivalent.

**The schema is a living document.** BML deliberately defers every visual
decision to this layer, so the schema must grow whenever a sentinel or feature
needs a styling home it does not yet have — §3.10's list of what BML does not
express is, equivalently, the checklist of what `metadata.json` must eventually
be able to express. Where this section does not yet define a key for something,
the renderer applies a sensible default, and adding the key is routine schema
work (a new entry in `metadata/types.ts` plus `css-generator.ts` support), not a
design change. Expanding this schema is an expected, ongoing task across all
plans.

### 4.1 Book directory structure

```
books/
  common-sense/
    manuscript.md
    metadata.json          ← the unnamed edition
    editions/              ← optional: named editions, one complete metadata file each
      pocket.json
    images/
  great-gatsby/
    manuscript.md
    metadata.json
```

> **Editions.** A book may carry several _editions_: purely styling variants of
> the same manuscript. `metadata.json` is the unnamed edition; each
> `editions/<slug>.json` is a named one, and every one is a complete
> self-contained metadata file (no inheritance). Editions share `manuscript.md`
> and `images/` byte for byte. Everything that takes a book also takes an
> optional edition: `?edition=` in the app, `--edition` on the CLI, and
> `/api/books/:book/editions/:edition/metadata` on the server.

### 4.2 Full schema

```json
{
  "page": { ... },
  "fonts": { ... },
  "elements": { ... },
  "is": { ... },
  "numbering": { ... },
  "running": { ... },
  "print": { ... },
  "notes": { ... },
  "toc": { ... }
}
```

### 4.3 Section: `page`

Controls the physical page canvas.

```json
"page": {
  "size": "5.5in 8.5in",
  "margins": {
    "top": "18mm",
    "bottom": "22mm",
    "inside": "22mm",
    "outside": "16mm"
  }
}
```

- `size` accepts any value valid in CSS `@page { size: ... }`: named sizes
  (`"A5"`, `"A4"`, `"letter"`) or explicit dimensions (`"5.5in 8.5in"`,
  `"148mm 210mm"`). This handles half-letter, quarter-legal, and any custom trim
  size.
- Margins use `inside`/`outside` rather than `left`/`right` so the renderer can
  mirror them correctly for verso/recto pages.

### 4.4 Section: `fonts`

Named aliases pointing to Google Fonts family names. Elements reference aliases
by key.

```json
"fonts": {
  "body": "EB Garamond",
  "display": "Playfair Display",
  "mono": "Courier Prime"
}
```

- Values are exact Google Fonts family names. The renderer generates the font
  `<link>` tags automatically (not `@import` — see §5.2 note on the split
  between processed and unprocessed CSS).
- Any number of aliases can be defined. `body`, `display`, `mono` are a typical
  starting set.
- Elements reference these by alias key (e.g. `"font-family": "display"`). The
  renderer resolves the alias to the actual family name.

### 4.5 Section: `elements`

Per-element CSS overrides. Property names and values are CSS. Elements that
represent a _page type_ (half-title, title-page, copyright, etc.) nest their
sub-elements. Elements that are a single typographic unit (heading, dropcap,
etc.) are flat. Sub-elements may themselves nest, to any depth; each level
becomes a descendant selector (`toc → toc-part → number` is
`.matter-toc .toc-part .number`). One property is special: `content` on
`toc.leader` is emitted as the `--leader` custom property that the base
stylesheet repeats across the row (§4.5 recipes); everywhere else `content` sets
the element's `::before`, as for `break`.

```json
"elements": {

  "body": {
    "font-family": "body",
    "font-size": "11pt",
    "line-height": "1.5",
    "text-align": "justify"
  },

  "half-title": {
    "title": {
      "font-family": "display",
      "font-size": "22pt",
      "text-align": "center"
    }
  },

  "title-page": {
    "title": { "font-family": "display", "font-size": "26pt", "text-align": "center" },
    "subtitle": { "font-size": "13pt", "font-style": "italic", "text-align": "center" },
    "author": { "font-size": "12pt", "text-transform": "uppercase", "letter-spacing": "0.08em", "text-align": "center" },
    "edition": { "font-size": "9pt", "font-style": "italic", "text-align": "center" },
    "epigraph": { "font-size": "9.5pt", "font-style": "italic" },
    "imprint": { "font-size": "9pt", "text-align": "center" }
  },

  "copyright": {
    "copyright-line": { "font-size": "9pt" },
    "rights": { "font-size": "8.5pt" },
    "isbn": { "font-size": "8.5pt" },
    "edition": { "font-size": "8.5pt", "font-style": "italic" }
  },

  "dedication": { "font-style": "italic", "text-align": "center" },

  "toc": {
    "title": { "font-family": "display", "font-size": "16pt", "text-align": "center" },
    "entry": { "font-size": "10pt" },
    "leader": { "content": ". " },
    "toc-part": { "margin-top": "1.2em", "font-variant": "small-caps" }
  },

  "prose-matter": {
    "title": { "font-family": "display", "font-size": "16pt", "text-align": "center" }
  },

  "part": {
    "title": { "font-family": "display", "font-size": "20pt", "text-align": "center" },
    "number": { "font-size": "11pt", "text-transform": "uppercase", "letter-spacing": "0.1em" }
  },

  "chapter": {
    "title": { "font-family": "display", "font-size": "15pt", "text-align": "center", "margin-top": "30pt", "margin-bottom": "30pt" },
    "number": { "font-size": "10pt", "text-transform": "uppercase", "letter-spacing": "0.08em" }
  },

  "heading": { "font-size": "11pt", "text-transform": "uppercase", "letter-spacing": "0.06em", "text-align": "center" },
  "subheading": { "font-size": "11pt", "font-style": "italic" },

  "epigraph": {
    "text": { "font-size": "9.5pt", "font-style": "italic", "margin-left": "15%" },
    "attribution": { "font-size": "8.5pt", "text-align": "right" }
  },

  "dropcap": { "font-family": "display", "font-size": "3.4em", "line-height": "0.82" },
  "em": { "font-style": "italic" },
  "break": { "content": "✦" },
  "pullquote": { "font-size": "13pt", "font-style": "italic", "text-align": "center" },
  "quote": { "font-size": "10pt", "margin-left": "10mm", "margin-right": "10mm" },
  "poem": { "font-size": "10pt", "margin-left": "15%" },
  "sidebar": { "font-size": "9pt", "border-left": "2pt solid #bbb", "padding-left": "12pt" },

  "verses": {
    "font-size": "10pt",
    "number": { "font-size": "7pt", "vertical-align": "super" }
  },

  "illustration": {
    "caption": { "font-size": "8.5pt", "font-style": "italic", "text-align": "center" }
  },

  "footnote": { "font-size": "8.5pt" },
  "colophon": { "font-size": "9pt", "text-align": "center" },

  "appendix": {
    "title": { "font-family": "display", "font-size": "15pt", "text-align": "center" }
  }
}
```

**Contents sub-elements.** `title` is the heading. Each listed item is an
`entry` row with a level class — `toc-front`, `toc-part`, `toc-chapter`,
`toc-heading`, `toc-back` (rows under a part also `in-part`, indented 1.5em by
default) — containing `number` (when `numbering` shows one), the `label` link,
`subtitle` (when present), an empty `leader`, and the `page` link whose
`::after` is the folio. Sub-elements nest, so `toc-part` may hold its own
`number`/`label`/`page` blocks. `leader.content` is any string, repeated across
the row and aligned right; `""` (the default) is no leader. Since every row
carries both `entry` and its level class, `.matter-toc .entry` and
`.matter-toc .toc-part` (etc.) have identical specificity — when both set the
same property, the one written later in `elements.toc` wins, so put level-class
keys (`toc-part`, `toc-chapter`, `toc-heading`, `toc-front`, `toc-back`) after
`entry` in `metadata.json`.

| Want                                     | `elements.toc`                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spaced dot leaders                       | `"leader": { "content": ". " }` — also `"."`, `"· "`, `"– "`                                                                                                                                                                                                                                                                        |
| Light dots                               | `"leader": { "content": ". ", "font-size": "0.85em", "opacity": "0.45" }`                                                                                                                                                                                                                                                           |
| Hairline rule                            | `"leader": { "content": "", "border-bottom": "0.3pt solid" }`                                                                                                                                                                                                                                                                       |
| Ornament                                 | `"leader": { "content": "✦ ", "font-size": "0.55em", "letter-spacing": "0.9em" }`                                                                                                                                                                                                                                                   |
| Folio before the title                   | `"page": { "order": "-1", "width": "2.4em", "text-align": "right", "margin-right": "1em" }, "leader": { "display": "none" }`                                                                                                                                                                                                        |
| No folios                                | `"page": { "display": "none" }, "leader": { "display": "none" }`                                                                                                                                                                                                                                                                    |
| Number column                            | `"number": { "width": "2.2em" }` (numbers appear when `numbering.chapters.show` is true)                                                                                                                                                                                                                                            |
| Close-set, no leaders                    | `"leader": { "display": "none" }, "entry": { "max-width": "80%", "margin": "0.4em auto 0" }`                                                                                                                                                                                                                                        |
| Parts as heads, no folio                 | `"toc-part": { "margin-top": "1.4em", "font-variant": "small-caps", "letter-spacing": "0.1em", "page": { "display": "none" }, "leader": { "display": "none" } }`                                                                                                                                                                    |
| Centered "Book One" over an italic title | `"toc-part": { "display": "block", "text-align": "center", "margin-top": "1.4em", "number": { "display": "block", "font-variant": "small-caps", "letter-spacing": "0.14em" }, "label": { "font-family": "display", "font-style": "italic", "font-size": "13pt" }, "leader": { "display": "none" }, "page": { "display": "none" } }` |
| Parts only                               | `"toc-chapter": { "display": "none" }`                                                                                                                                                                                                                                                                                              |
| Hide front matter                        | `"toc-front": { "display": "none" }`                                                                                                                                                                                                                                                                                                |
| Hanging indent for long titles           | `"label": { "padding-left": "1.5em", "text-indent": "-1.5em" }`                                                                                                                                                                                                                                                                     |

Notes on specific keys:

- `prose-matter` applies to the prose matter types — foreword, preface, and
  introduction.
- `break` styles every `{break}` sentinel type-wide. Per-kind treatment for
  slugged breaks (`{break: passage-of-years}`) is addressed by slug, via the
  per-slug override mechanism added in Plan 4 (§7.4, §9) — the same way any
  other slugged sentinel gets a one-off or per-kind style.
- `verses.number` styles the auto-assigned verse numbers; `illustration.caption`
  styles the caption line.
- This list mirrors the tag reference in §3.9 but is not yet exhaustive — per
  the living-document rule (§4 intro), keys are added as books need them.

Styles for custom semantic blocks declared with `{is: class-name}` in the
markup. Each key matches the slug used in BML. Values are CSS property objects.
The renderer emits `.is-letter { ... }` etc.

```json
"is": {
  "letter": { "font-style": "italic", "margin-left": "10mm", "margin-right": "10mm" },
  "telegram": { "font-family": "mono", "text-transform": "uppercase", "letter-spacing": "0.05em" },
  "author-signature": { "text-align": "right", "font-style": "italic", "margin-top": "12pt" },
  "diary-entry": { "font-style": "italic", "border-left": "1pt solid #999", "padding-left": "10mm" }
}
```

### 4.7 Section: `numbering`

Controls how chapters, parts, and pages are numbered. Uses semantic style names
since CSS has no direct equivalent.

**`style` options:** `"arabic"`, `"roman-upper"`, `"roman-lower"`,
`"alpha-upper"`, `"alpha-lower"`, `"words"` (One, Two … Ninety-Nine; digits from
100), `"none"`. `"words"` applies to `chapters` and `parts` only — page counters
are CSS counters with no spelled form, so `pages.*.style: "words"` renders as
arabic and the configuration panel does not offer it there.

```json
"numbering": {
  "chapters": { "style": "roman-upper", "show": true, "prefix": "", "suffix": "." },
  "parts": { "style": "roman-upper", "show": true, "prefix": "Part ", "suffix": "" },
  "pages": {
    "css": { "font-family": "body", "font-size": "9pt" },
    "front-matter": { "style": "roman-lower", "show": true },
    "body": { "style": "arabic", "show": true },
    "back-matter": { "style": "arabic", "show": true, "css": { "font-family": "display" } }
  }
}
```

- `show` on chapters/parts controls whether the number is prepended to the title
  at all.
- `prefix`/`suffix` wrap the number: `"Chapter "` + `1` + `""` → "Chapter 1", or
  `""` + `IV` + `"."` → "IV."
- `show` on pages toggles page numbers on/off per section.
- `css` on pages styles the folio's margin box (CSS properties, font aliases
  resolved like §4.5). `pages.css` applies to every zone; a zone's own `css`
  overrides it property by property. Margin boxes are not descendants of the
  book body, so they inherit nothing from `elements.body` — without `pages.css`
  a folio renders in the browser's default font. Edited by the Styles panel
  (§7.4), which lists "All page numbers" alongside the three zones.
- **Current implementation note:** body page numbers are emitted via a single
  universal `@page { @bottom-center { content: counter(page, <style>); } }` rule
  (not per-odd/even), because Paged.js support for `@bottom-center` nested
  inside `@page :left`/`:right` is unreliable across versions. Front-matter and
  back-matter numbering restarts are handled with separate counter-reset rules
  keyed to the first page of each section.

### 4.8 Section: `running`

Controls what appears in the page margin boxes (headers/footers other than the
plain page number, which is handled by `numbering.pages`, §4.7). `odd` and
`even` each take an array of entries — any number of items, each placed in an
independent margin box.

**`area`** — any of the 16 CSS Paged Media margin boxes: `top-left-corner`,
`top-left`, `top-center`, `top-right`, `top-right-corner`, `right-top`,
`right-middle`, `right-bottom`, `bottom-right-corner`, `bottom-right`,
`bottom-center`, `bottom-left`, `bottom-left-corner`, `left-bottom`,
`left-middle`, `left-top`

**`content`** — `"book-title"`, `"chapter-title"`, `"part-title"`,
`"page-number"`, `"none"`, or a literal string. (`"page-number"` remains a legal
value for a running entry, e.g. if a user wants the page number paired in the
same margin box as a title, but the common case — a plain page number in its own
box — is handled automatically by `numbering.pages`, not by a `running` entry.)

All other properties in an entry are CSS and apply to that margin box.
`font-family` accepts a font alias and is resolved like §4.5. A margin box is
not a descendant of the book body, so it inherits nothing from `elements.body`:
without an explicit `font-family` a running head renders in the browser's
default font. The configuration panel offers the same font picker as the Styles
panel on each running entry (§7.5).

```json
"running": {
  "odd": [
    { "content": "book-title", "area": "top-right", "font-size": "8pt", "font-style": "italic" }
  ],
  "even": [
    { "content": "chapter-title", "area": "top-left", "font-size": "8pt", "font-style": "italic" }
  ]
}
```

Implemented via Paged.js `string-set`/`string()` for dynamic content values
(`book-title`, `chapter-title`, etc.). Paged.js is the single pagination engine
for both preview and export (§5.4, §6), so no native-Chrome fallback is needed.

### 4.9 Section: `print`

Physical print/imposition settings, consumed only by print export (§7.7). Kept
in `metadata.json` so a book's entire configuration lives in one file.

```json
"print": {
  "sheet-size": "legal",
  "folios-per-signature": 4,
  "duplex": "short-edge"
}
```

- `sheet-size` — the physical paper the printer loads. Same value space as
  `page.size` (§4.3): named sizes or explicit dimensions.
- `folios-per-signature` — signature thickness, counted in folios (one folio =
  one folded piece = 4 book pages, §7.7). Signature page count =
  `folios-per-signature` × 4.
- `duplex` — `short-edge` (book-style turn, default), `long-edge`
  (calendar-style turn), or `none` (separate fronts/backs files). CLI flags
  (`bml export --sheet/--folios/--duplex`) override per run.

> Named editions export to `export/<edition>/` and render to
> `render.<edition>.html`; the unnamed edition keeps `export/` and
> `render.html`. Print settings always come from the edition's own metadata.

### 4.10 Section: `notes`

Controls how `{note:}` content (§3.6.8) is placed.

```json
"notes": {
  "placement": "footnote"
}
```

- `placement` — `"footnote"` (bottom of the page carrying the anchor) or
  `"endnote"` (collected at the end of the enclosing chapter or matter block).

### 4.11 Renderer responsibilities

When `metadata.json` is present, the renderer:

1. Loads Google Fonts via `<link>` tags for each entry in `fonts`, requesting
   the default variant set (400, 400 italic, 700, 700 italic) for each family.
2. Resolves font aliases in `elements` and `is` to actual family names.
3. Emits `@page { size; margin-inside; margin-outside; }` from `page`.
4. Generates CSS rules for each element, mapping the nested structure to the
   appropriate CSS selectors.
5. Generates `.is-*` classes from `is`.
6. Applies chapter/part number formatting from `numbering`.
7. Emits page-number `@page` rules from `numbering.pages`, and margin-box rules
   from `running`.
8. Resolves image slugs (`{illustration: slug}`, `{dropcap | image: slug}`)
   against the book's `images/` directory, trying `<slug>.svg`, `.png`, `.jpg`,
   `.jpeg`, `.webp` in that order and using the first match; an unresolved slug
   renders a visible placeholder, not an error.
9. Resolves `{ref: slug}` to the target's page number via Paged.js
   `target-counter()`.
10. Generates the table of contents for a `{matter: toc}` block from the
    document tree (§3.4.6): one `.entry` row per item, classed `toc-front`,
    `toc-part`, `toc-chapter`, `toc-heading` or `toc-back` (rows under a part
    also `in-part`), each holding optional `.number` and `.subtitle`, a `.label`
    link, an empty `.leader`, and an empty `.page` link whose `::after` is
    `target-counter()`. If the toc block contains manuscript prose, that prose
    is used verbatim instead.
11. Places `{note:}` content as footnotes or endnotes per `notes.placement`
    (§4.10).

### 4.12 Section: `toc`

What the generated contents (§3.4.6) lists beyond the structure it always lists.
Everything _visual_ about the contents is CSS under `elements.toc` (§4.5).

```json
"toc": { "headings": true }
```

- `headings` — list level-1 `{heading: slug}` entries under their chapter,
  indented one step further than the chapter row (class `toc-heading`). Only
  headings with a slug are listed, since only they have an anchor to link to;
  `{subheading}` is never listed. Default `false`. Only headings that are direct
  children of the chapter are listed — a heading nested inside a `{quote}`,
  `{sidebar}`, `{is:}`, or `{columns}` block belongs to that block, not to the
  chapter's outline, and is never collected into the contents.

---

## 5. Module Contracts

These are the contracts each module must satisfy, per the layout in §1. Plan 0
(§9) implements §5.1–§5.3; Plan 1 implements the live half of §5.4; Plan 5
implements the print-export half.

### 5.1 `parser/` — BML → tree

- `parse(source: string): BmlDocument` in `parser.ts`. Pure function, no I/O.
- `BmlDocument = { frontMatter: FrontMatterBlock[], body: BodyBlock[], backMatter: BackMatterBlock[] }`
  — the full node type hierarchy (chapters, parts, paragraphs, epigraphs,
  verses, illustrations, sidebars, columns, `is` blocks, lists, notes, all
  front/back matter variants) is defined in `parser/types.ts` and mirrors the
  tag reference in §3.9 one-to-one.
- Any UI that needs to reflect document structure (the project tree, §7.2;
  sentinel click targets, §7.4) walks this tree — it does not re-parse BML
  itself.
- `parser_test.ts` is the executable specification of the grammar in §3: one
  test per construct, covering the closing-form rules in §3.2.3 in particular.
  When BML syntax is extended later, tests are added here first.

### 5.2 `metadata/` — styling config → CSS

- `loadMetadata(bookDir: string): Promise<Metadata | null>` in `loader.ts`.
- `Metadata` type tree in `types.ts` mirrors §4's schema one-to-one
  (`PageConfig`, `Elements`, `Numbering`, `Running`, etc.).
- `css-generator.ts` exports three functions, all consumed by both preview and
  export since Paged.js is the single pagination engine (§6):
  - `generatePagedCSS(metadata, { bookTitle }): string` — `@page`, numbering,
    and running-header rules targeting Paged.js (`string-set`/`string()`,
    `target-counter()`).
  - `generateDomCSS(metadata): string` — plain per-element selector rules
    (fonts, sizes, colors); ordinary page CSS.
  - `generateFontLinks(metadata): string` — `<link>` tags for Google Fonts,
    resolved from `fonts` aliases.
- `css-generator_test.ts` covers each generator function against representative
  metadata fragments.

### 5.3 `renderer/` — tree → HTML

- `render(doc: BmlDocument, opts: { numbering?: Numbering }): string` in
  `render.ts` — walks the parsed tree and emits semantic HTML (one element per
  BML construct), applying chapter/part number formatting from `opts.numbering`.
  Used identically by both consumers in §5.4 — it emits plain semantic HTML and
  has no knowledge of pagination.
- `base.css` — base structural CSS (page box baseline, typography resets) that
  is always included, independent of any book's `metadata.json`.

### 5.4 `server/` — one pipeline, two consumers

Both entry points compose the same pipeline — `parse` → `render` →
`generatePagedCSS` + `generateDomCSS` + `generateFontLinks` (§5.1–§5.3) — with
Paged.js as the single pagination engine. Because preview and export share the
layout engine, the preview is the export by construction.

- `dev-server.ts` — **live preview** (§6, §7.6). Serves the pipeline output to
  the browser wrapped with Paged.js for on-screen pagination, and pushes updates
  over a WebSocket whenever a watched book's `manuscript.md`/`metadata.json`
  changes.
- `print-export.ts` — **print export** (§7.7). Prints the Paged.js document to
  `book.pdf` at trim size via headless Chrome, then imposes at the PDF level
  (pdf-lib) onto sheet-sized pages. Preview == export still holds: the pages are
  Paged.js's own, untouched.

---

## 6. Web Application Architecture

- **Backend:** Deno throughout — the parser, metadata/CSS generation, renderer,
  dev server, and print export all run on Deno. No other backend
  language/runtime.
- **Frontend:** Vanilla TypeScript + CodeMirror 6 for the BML editor pane. The
  application surface (tree, editor, preview, a couple of form panels) does not
  need a component framework; CodeMirror provides syntax highlighting,
  decorations (for clickable sentinels, §7.4), and cursor/selection APIs for
  free, which is most of what the UI needs.
- **Live loop:** `dev-server.ts` (§5.4) watches each open book's `manuscript.md`
  and `metadata.json`, re-runs `parse` → `render` → `css-generator` on change,
  and pushes the updated HTML/CSS to the browser over a WebSocket — instant
  feedback with no manual refresh. This is the first thing built (Plan 1, §9)
  because every other feature depends on it. A change that originated from a
  client's own editor buffer is not echoed back to that client — the update is
  suppressed (or version-tagged and ignored) for the originating editor, so a
  save never round-trips and clobbers the buffer or cursor.
- **One pagination engine (§5.4):** Paged.js paginates both the live preview and
  the print export. Chosen deliberately over a hybrid
  Paged.js-preview/native-Chrome-export split: (a) the preview and the exported
  file come from the same layout engine, so the preview is exact by construction
  rather than by careful synchronization of two CSS generators; (b) running
  headers (`string-set`/`string()`), `{ref:}` page numbers, and TOC page numbers
  (`target-counter()`) all require CSS features Paged.js implements and Chrome
  does not support natively. Export works by printing the already-paginated,
  sheet-imposed DOM (§5.4, §7.7) — at that point printing is 1:1 and the browser
  contributes no layout.
- **State of truth:** `manuscript.md` and `metadata.json` on disk remain the
  only source of truth. The UI never holds authoritative state client-side
  beyond an in-memory editor buffer that is flushed to disk on change
  (debounced) — no database, no separate document format.
- **Multi-book:** the app operates over the `books/` directory; a book switcher
  (part of the project tree, §7.2) lets the user move between books without
  restarting the server.

---

## 7. Feature Specifications

### 7.1 Overall Layout

```
+-------------------------------------------------------------+
|                      Tool Bar (fixed)                        |
+-----------+----------------------------+----------------------+
|           |                            |                      |
|  Project  |        Plain BML           |   Preview (spread)   |
|   Tree    |        (CodeMirror)        |   Odd page | Even    |
|           |                            |                      |
+-----------+----------------------------+----------------------+
```

Three panes side by side under a fixed toolbar: project tree, BML editor, live
preview. This is the primary editing surface. Document configuration (§7.5) and
page setup (§7.7) open as overlays/panels rather than permanent panes, since
they're edited far less often than the manuscript itself.

### 7.2 Project Tree

Reflects the `BmlDocument` tree (§5.1) directly — front matter blocks, parts,
chapters (nested under their part per §3.2.3), back matter blocks — plus a book
switcher at the root for moving between books in `books/`. Clicking a node
scrolls the editor to and highlights the corresponding source range, and scrolls
the preview pane to the corresponding page. The tree is read-only with respect
to structure in v1 (reordering/dragging nodes is out of scope, §8) — it is a
navigation aid, not a structural editor.

### 7.3 Markup Editing Pane

CodeMirror 6 over plain BML text.

- Syntax highlighting distinguishes sentinels, slugs, key-value pairs, comments,
  and escapes (§3.2).
- Parse-on-change (debounced): the buffer is re-parsed with `parse()` after each
  edit pause; parse/structural errors (unclosed blocks, illegal nesting per
  §3.2.3, mismatched `{is:}` class names) are shown as inline gutter markers,
  not as blocking dialogs — BML tolerates an unclosed block by falling back to
  implicit-close (§3.2.3), so most "errors" are really just "here's where it
  fell back."
- A toolbar (§7.1) inserts sentinel snippets at the cursor — one button/shortcut
  per common sentinel (chapter, part, heading, dropcap, em, footnote, etc.),
  inserting the correct open/close pair for that sentinel's closing form
  (§3.2.3).

### 7.4 Sentinel Styling

A visual layer over the _existing_ `metadata.json` schema (§4) — no new file
format, no new schema. Clicking a sentinel's rendered output in the preview, or
its corresponding span in the editor, opens a style panel scoped to that
sentinel.

The panel exposes the selector model already implicit in `elements`/`is` (§4.5,
§4.6):

- **By type** — every sentinel of this kind (e.g. all `{chapter:}` titles) →
  writes to `elements.chapter.title`. Nested sub-elements (§4.5) are their own
  entries — the Contents group lists part and chapter `number`/`label`/`page`
  separately — and a preview click resolves to the deepest matching selector, so
  clicking a part number in the contents opens `elements.toc.toc-part.number`.
- **By slug** — every sentinel sharing this slug (e.g. every
  `{is: handwritten-letter}`) → writes to `is.handwritten-letter`.
- **By single instance** — this one occurrence only, addressed by its slug, so
  the rule survives tree reorganization (per §3.2.4's slug-stability guarantee)
  → requires extending the schema with a per-slug override map, since v1 of the
  schema (§4) only supports type-wide and class-wide rules, not one-off
  overrides. This is a schema addition, tracked explicitly in Plan 4 (§9).

Style edits write CSS property values directly (matching §4.5's CSS-centric
design — no translation layer), and the live loop (§6) re-renders immediately so
the effect is visible in the preview pane without a save step.

The font picker's empty option names what the box actually renders in when it
sets no font of its own — `(unset — Crimson Pro)` for an element inside the book
body, `(unset — serif)` for the body itself (base.css),
`(unset — browser
default)` for a margin box, which is outside the body and
inherits nothing from it (§4.7, §4.8). "Inherit" would be a lie in the last two
cases.

### 7.5 Document Configuration Panel

Form UI mapped 1:1 to `metadata.json`'s `page`, `fonts`, `numbering`, `running`,
`print`, and `notes` sections (§4.3, §4.4, §4.7–§4.10) — replacing hand-editing
JSON for the settings that apply to the whole book rather than one sentinel
type. Opens as a panel/overlay, not a permanent pane (§7.1). Includes:

- Book page size (named presets and custom dimensions) and margins
- Font aliases (name → Google Fonts family, with a searchable picker)
- Chapter/part numbering style, prefix/suffix, show/hide
- Running header/footer entries per margin box, odd/even
- Print setup: sheet size and folios per signature (§4.9, consumed by §7.7)
- Note placement: footnotes vs. endnotes (§4.10)

### 7.6 Preview Pane

The live, print-accurate spread view:

```
+-------------------+  +--------------------+
|                    |  |                    |
|     Odd Page       |  |     Even Page      |
|                    |  |                    |
+-------------------+  +--------------------+
```

Rendered via the live preview pipeline (§5.4, §6), updated over the WebSocket
whenever `manuscript.md` or `metadata.json` changes. Must faithfully reflect
page size, margins, running headers, page numbers, verses, columns, and table of
contents exactly as the print export (§7.7) will — the whole point of the live
preview is that it is not an approximation.

### 7.7 Page Setup & Print Imposition

The one subsystem with no analogue in §5's other modules — a new algorithm, not
an adaptation of existing logic. This is where "book pages" (the trim size the
manuscript is laid out at, e.g. 5.5in × 8.5in) get imposed onto physical
"sheets" (what the printer/binder actually prints on, e.g. US Legal) for
hand-binding.

**Configuration** (from `metadata.json`'s `print` section, §4.9): `sheet-size`
and `folios-per-signature`.

**Binding model (fixed, not configurable in v1, §8).** All folds are vertical,
parallel to the spine. A **folio** is one folded piece of paper: 2 leaves, 4
book pages. Folios nest inside one another to form a **signature** of
`folios-per-signature` folios (= `folios-per-signature` × 4 book pages); the
book is a sequence of signatures.

**Layout derivation.** Book pages sit in a single row on each sheet side. The
n-up count is derived, not configured: _n_ = the largest even number such that
_n_ × page-width ≤ the sheet's long side and page-height ≤ the sheet's short
side.

- _n_ = 2 — the sheet is folded once at its center; one sheet = one folio.
- _n_ = 4 — the sheet is cut at its vertical center, and each half is folded;
  one sheet = two folios.
- In general, _n_/2 folios per sheet, separated by _n_/2 − 1 cuts. _n_ = 2 and
  _n_ = 4 are the expected v1 cases; the math generalizes but higher counts are
  untested.
- If _n_ < 2 (two book pages don't fit on the sheet), export fails with a clear
  configuration error.

Example: a 3.5in × 8.5in book page on US Legal (14in × 8.5in) gives _n_ = 4
(cut + fold, 8 pages per duplex sheet); a 5.5in × 8.5in page on the same sheet
gives _n_ = 2 (fold only, 4 pages per sheet).

**Imposition algorithm (`server/imposition.ts`, Plan 5):**

1. Take the total page count from the Paged.js-paginated document (§5.4); pad
   the final signature with blank pages up to a multiple of
   `folios-per-signature` × 4.
2. For each signature of _F_ folios (_P_ = 4_F_ local pages), assign pages to
   folios by the standard nesting mapping — folio _k_ (1 = outermost) carries,
   on its front face, local pages [_P_−2_k_+2 | 2_k_−1] (left | right of the
   fold) and, on its back face, [2_k_ | _P_−2_k_+1] — so that folding and
   nesting reconstructs reading order. (Check, _P_ = 16: folio 1 is [16 | 1]
   front, [2 | 15] back.)
3. Pack folios onto physical sheets, _n_/2 folios per sheet side by side.
   Back-side layout follows `print.duplex`: `short-edge` (book-style turn on a
   landscape sheet) mirrors the folio column order with each `[2k | P−2k+1]`
   pair intact; `long-edge` (calendar-style turn) is that layout rotated 180° as
   a whole.
4. Emit the final print file via `print-export.ts` (§5.4, §6) — one output page
   per sheet side, at the sheet's physical dimensions, with the
   already-paginated book pages positioned at their exact trim size.

**Output:** one `sheets.pdf` (or `sheets-fronts.pdf` + `sheets-backs.pdf` for
`duplex: none`), built by embedding `book.pdf` pages onto sheet-sized PDF pages;
`--proof` emits numbered placeholders for a one-sheet printer check.

---

## 8. Non-Goals

Explicitly out of scope, to bound the work below:

- Binding styles other than the §7.7 model — vertical folds parallel to the
  spine, folios nested into signatures (no horizontal folds/quarto-style
  imposition, no perfect binding with spine text, etc.)
- Fonts from anywhere other than Google Fonts
- Multi-user/collaborative real-time editing
- Structural editing via drag-and-drop in the project tree (§7.2) — tree is
  navigation-only in v1
- Image upload/management UI — `{illustration:}` slugs are assumed to resolve to
  files the user places manually for now
- Automated table-of-contents _authoring_ beyond what the renderer already
  generates from the tree (manual TOC entry per §3.4.6 remains available as a
  fallback)
- Accessibility/EPUB or other non-print output formats

---

## 9. Build Plan

Each plan below is scoped to be handed to one agent working somewhat
independently, with a clear dependency chain. Plans 2–4 can be parallelized
across agents once Plan 1 lands, since they touch mostly-disjoint UI surfaces
sharing the same live-server contract. Plan 5 has no UI dependency and can start
any time after Plan 0.

### Plan 0 — Core Pipeline

- **Depends on:** nothing.
- **Goal:** implement `parser/`, `metadata/`, and `renderer/` (§5.1–§5.3) from
  this spec, and author the two validation books.
- **Deliverables:** `parser.ts` implementing §3's full grammar with
  `parser_test.ts` covering every construct in §3.9; `metadata/types.ts` +
  `loader.ts` + `css-generator.ts` (all three functions, §5.2) with tests;
  `renderer/render.ts` + `base.css`; `books/common-sense/manuscript.md` +
  `metadata.json` and `books/great-gatsby/manuscript.md` + `metadata.json`, both
  exercising front matter, parts/chapters, at least one of each special block
  (§3.6), and a full `metadata.json` (§4). A throwaway script wiring
  `parse → render → css-generator` together is fine for manual verification
  during this plan — it is not a deliverable and is discarded once Plan 1 lands.
- **Definition of done:** `deno test` green across `parser/` and `metadata/`;
  both validation books produce valid, inspectable HTML+CSS output with no
  errors.

### Plan 1 — Live Dev Server

- **Depends on:** Plan 0.
- **Goal:** `server/dev-server.ts` (§5.4) — the live preview pipeline with
  instant feedback, per §6.
- **Deliverables:** a Deno server that (a) serves the app shell, (b) watches the
  active book's `manuscript.md`/`metadata.json`, (c) on change re-runs
  `parse → render → generatePagedCSS/generateDomCSS/generateFontLinks` and
  pushes updated HTML/CSS over a WebSocket to any connected client, (d) exposes
  an endpoint to write editor buffer changes back to `manuscript.md`
  (debounced).
- **Definition of done:** editing `manuscript.md` in any text editor updates a
  connected browser tab within ~1s with no manual refresh.

### Plan 2 — Editor Shell

- **Depends on:** Plan 1.
- **Goal:** the three-pane layout in §7.1, with the tree (§7.2) and CodeMirror
  editor (§7.3) wired to the live server.
- **Deliverables:** toolbar, project tree walking `BmlDocument`, CodeMirror pane
  with BML syntax highlighting, parse-error gutter markers, sentinel-insertion
  toolbar buttons, click-to-scroll between tree/editor/preview.
- **Definition of done:** a user can open `common-sense`, navigate via the tree,
  edit BML, and see inline parse feedback, with changes flushed to disk.

### Plan 3 — Document Configuration Panel

- **Depends on:** Plan 1 (can run parallel to Plan 2).
- **Goal:** §7.5 — forms over `page`, `fonts`, `numbering`, `running`, `print`,
  and `notes`.
- **Deliverables:** panel UI reading/writing `metadata.json`'s book-wide
  sections; live-loop re-render on save. (The `print` fields feed Plan 5's
  export but are just more form fields here.)
- **Definition of done:** every field in §4.3/4.4/4.7–4.10 is editable without
  hand-touching JSON, and edits are visible in the preview immediately (print
  fields excepted — they only affect export).

### Plan 4 — Sentinel Styling UI

- **Depends on:** Plan 2 (needs the editor's sentinel spans) and Plan 3 (shares
  form-panel patterns).
- **Goal:** §7.4 — clickable sentinel styling with the three-tier selector model
  (type / slug / single-instance).
- **Deliverables:** click-to-style from editor or preview; type- and slug-level
  rules writing to `elements`/`is`; the schema extension for single-instance
  overrides (new section, e.g. `overrides: { <slug>: CssProps }`, resolved with
  highest specificity) plus the corresponding `css-generator.ts` support and
  tests.
- **Definition of done:** styling a single occurrence of a sentinel by slug does
  not affect other sentinels of the same type or class.

### Plan 5 — Print Imposition & Export

- **Depends on:** Plan 0 only.
- **Goal:** §7.7 and `server/print-export.ts` (§5.4) — the imposition algorithm
  and print-ready export, configured by `metadata.json`'s `print` section
  (§4.9). (The form UI for those settings lives in Plan 3's config panel.)
- **Deliverables:** imposition module deriving the n-up layout from sheet/page
  dimensions and computing the folio page-position mapping of §7.7, generalized
  to F folios per signature, with unit tests hand-verified against at least one
  2-up and one 4-up signature; `print-export.ts` producing a single print-ready
  file from the Paged.js-paginated document.
- **Definition of done:** for a known book page count and a chosen
  folios-per-signature value, the generated print file's page order reconstructs
  correct reading order when cut and folded per the §7.7 binding model (verify
  by hand-simulating one signature, physically if needed).

### Plan 6 — Integration & Polish

- **Depends on:** Plans 2, 3, 4, 5.
- **Goal:** tie the pieces together into one coherent app.
- **Deliverables:** multi-book switching end-to-end, consistent error states
  across panels, an end-to-end smoke test per book, a short README covering how
  to run the app and add a new book.
- **Definition of done:** a new user can clone the repo, run one command, open
  the app, pick a book, edit it, style it, and export a print file — without
  reading any code.

### Plan 7 — Table of Contents

- **Depends on:** Plans 0 and 4.
- **Goal:** §3.4.6, §4.5 (contents sub-elements and recipes), §4.12 — a
  generated contents page whose every visual choice is a CSS block in
  `metadata.json`, edited live in the style panel.
- **Deliverables:** row/span markup with level classes; right-anchored
  repeated-string leaders (`--leader`); zone-aware folios via
  `target-counter()`; numbers, subtitles, front and back matter, optional
  slugged headings; recursive element sub-styles; `words` numbering;
  style-catalog entries for every contents span.
- **Definition of done:** each recipe in §4.5 reproduces its layout on a real
  book in both the preview and `bml export`, with no change to the renderer.
