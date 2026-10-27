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
  upgrade.ts          — on-load schema upgrades for books written against an older shape
  page-setup.ts       — page/sheet geometry and the named setups (see §4.3); shared with web/
  css-generator.ts     — generatePagedCSS / generateDomCSS / generateFontLinks (see §5.2)
  css-generator_test.ts

renderer/
  render.ts            — render(doc: BmlDocument, opts): string (BML tree → HTML)
  base.css             — base structural CSS (page box, typography resets), independent of any book's metadata.json

server/
  dev-server.ts        — Deno live dev server: watches manuscript.md/metadata.json, re-renders, pushes updates over a WebSocket (see §6)
  print-export.ts      — imposes the paginated book onto physical sheets and produces the print-ready file (see §7.7)
  epub-export.ts       — the same render split into chapter files and zipped as an EPUB 3 (see §7.8)

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
book-page dimensions (§7.7). A 4.25in × 7in book page quarters US Legal and
prints 4-up (8 book pages per duplex sheet); a 5.5in × 8.5in page on the same
sheet prints 2-up (4 book pages per sheet). The sheet is then folded whole —
once (folio), twice (quarto) or three times (octavo) — or cut into pieces that
are each folded once, or cut into loose leaves (§7.7 `fold`). Every folded piece
is made of **folios** — 2 leaves, 4 book pages — and folios nest inside one
another to form signatures. These are the binding styles in scope (see §8,
Non-Goals).

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

#### 3.2.9 Edition Spans (EXPERIMENTAL)

> **EXPERIMENTAL.** `{only}` may change or be removed in a later version. No
> other sentinel, and nothing outside `{only}` handling, depends on it.

`{only}` gates a run of whole blocks to some of the book's editions (§4.1). Its
edition list is the slug plus any further pipe-separated names; the default
edition's token is always `default`, whatever its display name, and a named
edition's token is its slug.

```
{only: pocket | default}
Appears in the pocket and default editions, not in large-print.
{/only}
```

- Building an edition keeps the content of spans that list its token and drops
  the rest. The `{only}` and `{/only}` lines are never output, and line numbers
  never shift: tag lines and dropped content read as blank lines.
- With no edition chosen (`bml check`), every span's content is parsed.
  `bml check` prints a `file:line: experimental: {only}` note per span to
  stderr; the notes never change its exit code.
- `{only}` must open outside any block and outside another `{only}`, must be
  closed by `{/only}`, and must name at least one edition. A token no edition of
  the book answers to is a diagnostic.
- Renaming a named edition rewrites its token in every `{only}` opening line of
  `manuscript.md`; nothing else in the manuscript changes.

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

Following Chicago, every matter section, every part and the first body page open
on a recto (`break-before: right` in `renderer/base.css`, a blank verso inserted
when needed), so odd folios fall on rectos. Two exceptions: the copyright page
is the title page's verso, and the colophon is not forced to a recto because
print imposition pins it to the last page of the last signature (§7.7). Chapters
open on a new page of either hand unless a book says otherwise.

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

The renderer gathers `{publisher}`, `{publisher-location}` and `{year}` into one
`imprint` block after the rest of the title page, keeping their source order;
`title-page.imprint` styles it (§4.5).

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

The copyright page sits at the foot of its text block by default, as is
conventional. `"justify-content"` on the `copyright` section moves it:
`"flex-start"` (top), `"center"` (middle) or `"flex-end"` (bottom, the default).
The style panel's Copyright part sets it as "On the page".

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
contents from the document tree (§4.10 item 10): front matter that has a
`{title}` (except the display pages — half-title, title page, copyright,
dedication, epigraph, and the contents itself), every part and chapter with its
number when `numbering` shows one and its `{subtitle}` if present, level-1
headings that carry a slug when metadata `toc.headings` is `true` (§4.11), and
back matter that has a `{title}` (except the colophon, §3.7). An untitled
chapter lists as its number alone, or its slug if numbers are off. Page numbers
come from the page map (§4.7); front- and back-matter rows use their zone's
page-number style (§4.7), so a preface shows `v`.

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
paragraph. An epigraph, here or book-level, is set as a block as wide as its
longest line and centred; `"epigraph": { "margin-left": … }` overrides that.

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

`full-page` makes the illustration a plate: it goes on a page of its own right
after the page where its sentinel falls, centred in the text block and shrunk to
fit, with no running head or folio. The text keeps filling whole pages around
it, even when that splits a paragraph across the plate (`renderer/plates.js`).

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
rendering decision (configured in `metadata.json`, §4.9). The anchor and its
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
    dictionary.json        ← optional: the book's own spelling words (§7.3)
    images/
  great-gatsby/
    manuscript.md
    metadata.json
```

> **Editions.** A book may carry several _editions_: purely styling variants of
> the same manuscript. `metadata.json` is the unnamed edition; each
> `editions/<slug>.json` is a named one, and every one is a complete
> self-contained metadata file (no inheritance). Editions share `manuscript.md`
> and `images/` byte for byte, with one experimental exception: `{only}` spans
> (§3.2.9) keep a run of blocks to some editions, and each edition is built with
> its own spans applied. Everything that takes a book also takes an optional
> edition: `?edition=` in the app, `--edition` on the CLI, and
> `/api/books/:book/editions/:edition/metadata` on the server.
>
> The unnamed edition is the book's _default_ edition. Its display name is
> `metadata.json`'s top-level `name` (default `"Standard"`), renamed through
> `POST /api/books/:book/editions/default/rename` with `{ name }`; a named
> edition's display name is its slug, title-cased. `default` is reserved and is
> never a named edition's slug. A new edition may be cloned from any edition
> (`from`), and never takes the default edition's `name`.

### 4.2 Full schema

```json
{
  "spec": "0.6",
  "name": "Standard",
  "language": "en",
  "page": { ... },
  "fonts": { ... },
  "elements": { ... },
  "is": { ... },
  "numbering": { ... },
  "running": { ... },
  "notes": { ... },
  "toc": { ... },
  "ebook": { ... }
}
```

`spec` is the version of this specification the file complies with, as written
at the head of §3. The template stamps it on new books and the loader stamps it
on files that lack one (they predate the key). The app compares it to its own
`SPEC_VERSION` (`metadata/upgrade.ts`) and warns on a book newer than itself;
unknown keys are kept, never dropped. Bumping `spec` after an on-load upgrade is
not done yet; see the todo in `docs/`.

`language` is the book's BCP 47 tag, default `"en"`: the renderer stamps it on
the article as `lang`, which is what `hyphens: auto` (§4.5) and the EPUB's
`dc:language` (§4.12) read. A Spanish book that leaves it unset hyphenates by
English rules.

### 4.3 Section: `page`

The physical setup of the edition: the book page, the sheet it is printed on,
and how those sheets fold into signatures. These are one decision, not two — a
page size only means something against the paper it has to tile — so they live
in one section.

```json
"page": {
  "size": "3.5in 8.5in",
  "margins": {
    "top": "12mm",
    "bottom": "14mm",
    "inside": "14mm",
    "outside": "10mm"
  },
  "sheet": "legal",
  "folios-per-signature": 4,
  "duplex": "short-edge"
}
```

- `size` — the book page, and the only part of this section the preview sees.
  Accepts any value valid in CSS `@page { size: ... }`: named sizes (`"A5"`,
  `"A4"`, `"letter"`) or explicit dimensions (`"5.5in 8.5in"`, `"148mm 210mm"`).
  This handles half-letter, quarter-legal, and any custom size.
- `margins` use `inside`/`outside` rather than `left`/`right` so the renderer
  can mirror them correctly for verso/recto pages. The fore edge of a folded
  signature is trimmed by hand after binding; compensate for that here rather
  than by shrinking `size`.
- `sheet` — the physical paper the printer loads. Same value space as `size`.
- `fold` — how a printed sheet becomes leaves (§7.7): `folio` (folded once),
  `quarto` (twice), `octavo` (three times), `cut` (cut into pieces, each folded
  once) or `leaves` (cut, never folded). Unset: whichever puts the most pages on
  a sheet, a true fold winning a tie.
- `folios-per-signature` — signature thickness in folios (one folio = one folded
  piece = 4 book pages, §7.7). Signature page count = `folios-per-signature`
  × 4. `"booklet"` puts every page in one signature: its folios are the page
  count ÷ 4, rounded up, sized from the preview in the panel and from the
  rendered `book.pdf` at export. A true fold rounds it up to whole folded sheets
  (quarto: even; octavo: a multiple of 4); loose leaves ignore it.
- `duplex` — `short-edge` (book-style turn, default), `long-edge`
  (calendar-style turn), or `none` (separate fronts/backs files, the backs
  printed by hand).
- `flip` — with `duplex: none`, the edge the stack turns over on before its
  backs are printed: `short-edge` (default) or `long-edge`. Lays the backs out
  as §7.7 step 3 does for `duplex`.
- `reverse-backs` — with `duplex: none`, `true` writes the backs file last sheet
  first, for printers that stack face up. Default `false`.
- `paper` — the paper stock, any CSS colour (`"#f3e9d2"`); unset is the default
  page stock, shown as Bright white. It tints the preview's pages only, so the
  author sees the book on the stock it will be printed on: print sheets, the PDF
  of the pages, `bml export` and the EPUB stay white, and nothing is written
  into the manuscript or the colophon. The panel offers Bright white (unset),
  Natural, Ivory, Cream and Recycled grey, and a custom colour.

CLI flags (`bml export --sheet/--fold/--folios/--duplex/--flip/--reverse-backs`)
override any of these per run.

Everything else about the setup is **derived**, never stored: the grid of pages
on a sheet side and which orientation it prints in (§7.7's `cols` × `rows`),
folios and cuts per sheet, sheets per signature, and the leftover paper trimmed
off after folding. `metadata/page-setup.ts` resolves a `page` section into all
of it, and is shared by the configuration panel (§7.5) and print export (§7.7)
so the two can never disagree. A setup whose page cannot fit two-up on its sheet
is an error the panel shows as you pick it, and `bml export` refuses before
rendering.

The panel offers `size` and `sheet` as two independent dropdowns — there is no
third "setup" control, because the pair already is the setup and a page that
will not tile its sheet is reported inline as you pick it. The page-size list
includes the folded formats (half letter, quarter legal, A5 folded, …), each
**derived** from its sheet by `foldedSize(sheet, cols, rows)` rather than
written out, so a named size can never drift from the paper it comes off.
Halving folds once and splits the sheet's long side; quartering halves **both**
of its dimensions, so a quarter legal is 4.25in × 7in — a scaled-down sheet, not
a strip of one.

> Page setup is what makes one edition different from another, so it is the lead
> line in the edition picker. Named editions export to `export/<edition>/` and
> render to `render.<edition>.html`; the unnamed edition keeps `export/` and
> `render.html`. Setup always comes from the edition's own metadata.

### 4.4 Section: `fonts`

Named aliases pointing to font family names: a Google Fonts family, or a font
installed on the machine that renders the book. Elements reference aliases by
key.

```json
"fonts": {
  "body": "EB Garamond",
  "display": "Playfair Display",
  "mono": "Courier Prime"
}
```

- Values are exact family names. For Google Fonts families the renderer
  generates the font `<link>` tags automatically (not `@import` — see §5.2 note
  on the split between processed and unprocessed CSS).
- Any other name is an installed font: Chrome finds it by family name on the
  machine doing the preview or the print export, so nothing is loaded or copied.
  A book using one only renders right where that font is installed; the Fonts
  tab and print export warn when a family is neither a Google family nor
  installed (macOS only — elsewhere every non-Google family warns). EPUB export
  embeds no fonts of either kind, so readers fall back to their own.
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
the element's `::before`, as for `break`. One sub-element key is special: `em`
styles the emphasis element (§3.2.7) inside its parent, so
`title-page → subtitle → em` is `.matter-title-page .subtitle em`. `paragraph`
styles body paragraphs (`.bml p`); its typical keys are `text-indent` (the base
default is `1.5em`) and `margin-top` in `lh` units for space between paragraphs
(`"0.5lh"`). The paragraph that opens a block (`.lead`: first in its container,
or after a title, heading or break) and the drop-cap paragraph stay flush and
tight whatever `paragraph` says; one after a quote, poem, list or other block
keeps its indent. Pullquote text and attributions are flush. `body` is the whole
text block (`.bml`); `"hyphens": "auto"` there turns on the browser's dictionary
hyphenation for the book's `language` (the template ships with it on, since
justified text without it sets rivers). Titles, numbers and headings never
hyphenate whatever `body` says, and the base stylesheet allows no fragment under
three letters (`hyphenate-limit-chars: 6 3 3`). Display matter (half-title,
title-page, copyright, dedication, epigraph, colophon) sets lines, not prose:
its paragraphs take `text-indent` from the section, none by default, so
`"dedication": { "text-indent": "1.5em" }` indents a dedication.

```json
"elements": {

  "body": {
    "font-family": "body",
    "font-size": "11pt",
    "line-height": "1.5",
    "text-align": "justify"
  },

  "paragraph": { "text-indent": "1.5em", "margin-top": "0" },

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
    "text": { "font-size": "9.5pt", "font-style": "italic" },
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
The renderer emits `.is-letter { ... }` etc. Paragraphs inside an `is` block are
not indented unless the block sets `text-indent` (it inherits), so an
`author-signature` aligns flush right. The style panel gives each `is` class one
CSS box, and lists every class the manuscript uses, styled or not.

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
100), `"none"`. `"words"` applies to `chapters` and `parts` only —
`pages.*.style: "words"` renders as arabic and the configuration panel does not
offer it there.

```json
"numbering": {
  "chapters": { "style": "roman-upper", "show": true, "prefix": "", "suffix": "." },
  "parts": { "style": "roman-upper", "show": true, "prefix": "Part ", "suffix": "" },
  "pages": {
    "css": { "font-family": "body", "font-size": "9pt" },
    "front-matter": { "style": "roman-lower", "show": true },
    "body": { "style": "arabic", "show": true },
    "back-matter": { "style": "arabic", "show": true, "css": { "font-family": "display" } },
    "openers": { "position": "bottom-center" }
  }
}
```

- `show` on chapters/parts controls whether the number is prepended to the title
  at all.
- `prefix`/`suffix` wrap the number: `"Chapter "` + `1` + `""` → "Chapter 1", or
  `""` + `IV` + `"."` → "IV."
- `show` on pages toggles page numbers on/off per section.
- Page counting follows the Chicago Manual of Style: front matter counts from 1
  in its own style, the body restarts at 1, and back matter continues the body's
  count (no restart). Every page counts, including display pages, plates and
  blank padding pages, but display pages (half-title, title page, copyright,
  dedication, epigraph, colophon, plates) and blank pages print no folio.
  Chapter and part openers keep theirs unless `openers` says otherwise. TOC and
  `{ref}` numbers are the page's number regardless of whether its folio prints.
- `css` on pages styles the folio's margin box (CSS properties, font aliases
  resolved like §4.5). `pages.css` applies to every zone; a zone's own `css`
  overrides it property by property. Margin boxes are not descendants of the
  book body, so they inherit nothing from `elements.body` — without `pages.css`
  a folio renders in the browser's default font. Edited by the Styles panel
  (§7.4), which lists "All page numbers" alongside the three zones.
- `position` on pages places the folio: `"bottom-center"` (default),
  `"bottom-outside"`, `"top-center"` or `"top-outside"`. Outside is the
  fore-edge: `bottom-right`/`top-right` on recto (`:right`), `-left` on verso
  (`:left`). It applies to every zone.
- `openers` on pages is the one override of the drop rules: a page holding the
  start of a chapter or part (titled or not, in any zone) already carries no
  running head (§4.8), and Chicago either keeps its folio, omits it, or sets it
  at the foot of the page (a _drop folio_). `show: false` omits it; `position`
  (a folio position, as above) moves it, so a book with
  `"position": "top-outside"` and `"openers": { "position": "bottom-center" }`
  numbers its openers at the foot. Unset, or set to the book's own position, an
  opener's folio sits where every other page's does. The opener's number still
  counts, so its TOC entry and `{ref}`s are unaffected. Edited in the Page
  numbers part of the Styles panel (§7.4).
- `gap` on pages (default `5mm`) is the clear space between the text block and
  the folio, whatever the folio's size: to the top of its figures (cap height)
  below the text block, to its baseline above it. The folio belongs to the text
  block, not the margin: raising a margin moves text and folio together. The
  generator emits this as `vertical-align: top; padding-top: <gap>` on a bottom
  box (`bottom` / `padding-bottom` on a top box) ahead of `css`, so a book's own
  keys win; `renderer/base.css` trims every top and bottom margin box's line to
  its cap height and baseline (`text-box: trim-both cap alphabetic`), so those
  are the box's edges. Oldstyle figures rise or dip a little past them; a book
  that uses them adds a millimetre to taste.
- **Current implementation note:** folios are not Paged.js counters. A handler
  (`renderer/folios.js`) builds a page map after layout: for every page its
  zone, its folio (counted per zone, body restarting at 1, formatted in the
  zone's `style`) and its running titles. It writes the folio to the page as the
  CSS variable `--folio`, and generated CSS reads it in one
  `@page front|body|back { @bottom-center { content: var(--folio); } }` rule per
  shown zone for a centred folio (not per-odd/even, because Paged.js support for
  `@bottom-center` nested inside `@page :left`/`:right` is unreliable across
  versions). An outside folio gets a `front:right { @bottom-right }` and
  `front:left { @bottom-left }` pair per zone (top boxes for `top-outside`). A
  zone with `show: false` or style `"none"` gets no rule. An `openers` position
  that differs from the book's gets the same rules again at its own boxes
  reading `var(--folio-opener)`: the handler fills `--folio-opener` and blanks
  `--folio` on an opener page, and the reverse on every other page, so no page
  shows two numbers. `pageNumberingConfig` resolves an opener position equal to
  the book's to no override, so the CSS and the handler agree. The per-zone
  `style` and `show`, and `openers`, reach the handler as the build's
  `pageNumbering`.

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

**`gap`** (on `running`, default `4mm`) — the clear space between a head and the
text block, whatever the head's size: to its baseline above the text block, to
its cap height below (as for folios, §4.7). Paged.js makes each top/bottom
margin box as tall as the margin and centres its content, so without anchoring a
head floats at half the margin. The generator anchors every `top-*` box to its
bottom edge and every `bottom-*` box to its top edge (`vertical-align` plus
`padding-bottom`/`padding-top` of `gap`), ahead of the entry's own keys, which
win. Side boxes (`left-*`, `right-*`) are not anchored.

```json
"running": {
  "gap": "4mm",
  "odd": [
    { "content": "book-title", "area": "top-right", "font-size": "8pt", "font-style": "italic" }
  ],
  "even": [
    { "content": "chapter-title", "area": "top-left", "font-size": "8pt", "font-style": "italic" }
  ]
}
```

Implemented from the page map (§4.7): after layout, `renderer/folios.js` records
each body page's chapter and part title (the first on the page, else carried
over from the previous page) and writes them to the page as `--chapter-title`
and `--part-title`. `chapter-title`, `part-title` and `page-number` read
`var(--chapter-title)`, `var(--part-title)` and `var(--folio)` in the margin
box; `book-title` and literal strings are emitted as
`var(--running-off, "<string>")`, and the page map sets `--running-off: ""` on
every page that carries no running head. Paged.js does the fragmentation for
both preview and export (§5.4, §6), so no native-Chrome fallback is needed.

A top or bottom row holding a centre box and a side box (a centred head beside
an outside folio) is laid out by `renderer/base.css`, not by Paged.js's text
measuring (0.4.3 squeezes the centre when only the right box has content): the
centre takes its natural width and the two sides share the rest equally, so the
head sits centred on the text block, the same on a recto as on a verso. Rows
with only a centre or only side boxes keep Paged.js's layout. A head that still
runs to a second line is a page-map warning (§5.4).

Running entries apply to body pages only (`@page body:right` /
`@page
body:left`): front and back matter keep their folios (§4.7) but carry no
running head, and display matter carries neither. Following Chicago, running
heads are also omitted on chapter and part openers (a page holding the start of
a chapter or part, titled or not; the folio stays unless
`numbering.pages.openers` drops or moves it, §4.7) and on blank padding pages
(which also lose their folio). `page-number` entries are folios and follow §4.7
instead. The page map leaves the title variables empty outside the body, so a
head can't carry the final chapter's title into the back matter.

### 4.9 Section: `notes`

Controls how `{note:}` content (§3.6.8) is placed.

```json
"notes": {
  "placement": "footnote"
}
```

- `placement` — `"footnote"` (bottom of the page carrying the anchor) or
  `"endnote"` (collected at the end of the enclosing chapter or matter block).

### 4.10 Renderer responsibilities

When `metadata.json` is present, the renderer:

0. Checks every key and value before writing it into CSS, and leaves out one
   that could end its declaration, rule or comment: an `elements` or sub-element
   key that isn't lowercase letters, digits and hyphens, an `is` name that isn't
   a slug (§3.2.4), a property name that isn't a CSS ident, a value containing
   `{`, `}`, `;`, `<` or `/*` or an unbalanced quote, and a `running` entry
   whose `area` isn't one of the 16 margin boxes. `content` is written as a CSS
   string, so any text is safe in it. A dropped value fails the way a typo does
   — the browser would ignore it anyway.
1. Loads Google Fonts via `<link>` tags for each entry in `fonts`, requesting
   the default variant set (400, 400 italic, 700, 700 italic) for each family
   (Google skips names it doesn't serve, which leaves installed fonts to Chrome;
   §4.4).
2. Resolves font aliases in `elements` and `is` to actual family names.
3. Emits `@page { size; margin-inside; margin-outside; }` from `page`.
4. Generates CSS rules for each element, mapping the nested structure to the
   appropriate CSS selectors.
5. Generates `.is-*` classes from `is`.
6. Applies chapter/part number formatting from `numbering`.
7. Emits page-number `@page` rules from `numbering.pages`, and margin-box rules
   from `running`; both read the page map's CSS variables (§4.7, §4.8).
8. Resolves image slugs (`{illustration: slug}`, `{dropcap | image: slug}`)
   against the book's `images/` directory, trying `<slug>.svg`, `.png`, `.jpg`,
   `.jpeg`, `.webp` in that order and using the first match. A resolved drop-cap
   image stands for the paragraph's first letter, which becomes its `alt`; an
   unresolved one falls back to the typeset initial. An unresolved illustration
   slug renders a visible placeholder, not an error:
   `<div class="illustration-placeholder" data-slug="<slug>">` reading "No image
   named <slug> yet" over "Click to add one". The copy is part of the render, so
   a `bml export` proof prints it too, and the page map warns of it (§5.4); the
   editor makes it a way to add the image (§7.6).
9. Resolves `{ref: slug}` to the target's page number: the page map (§4.7)
   records the page each anchor lands on, and its folio is written into the
   `a.ref` link as text.
10. Generates the table of contents for a `{matter: toc}` block from the
    document tree (§3.4.6): one `.entry` row per item, classed `toc-front`,
    `toc-part`, `toc-chapter`, `toc-heading` or `toc-back` (rows under a part
    also `in-part`), each holding optional `.number` and `.subtitle`, a `.label`
    link, an empty `.leader`, and a `.page` link whose text is the target's
    folio from the page map, in its zone's page-number style (§4.7). If the toc
    block contains manuscript prose, that prose is used verbatim instead.
11. Places `{note:}` content as footnotes or endnotes per `notes.placement`
    (§4.9).

### 4.11 Section: `toc`

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

### 4.12 Section: `ebook`

What the e-book export (§7.8) carries that print has no use for. Every key is
optional.

```json
"ebook": {
  "identifier": "urn:isbn:9780000000000",
  "language": "en",
  "cover": "cover"
}
```

- `identifier` — the package's unique identifier (`dc:identifier`). Default: a
  `urn:uuid` derived from the book slug and edition, the same on every export,
  so a reader's library sees a re-export as the same book. Set an ISBN urn here
  to publish through a store.
- `language` — the older spelling of the top-level `language` (§4.2), read only
  when that is unset.
- `cover` — an image slug in `images/`. Becomes the package's cover image and
  the first page of the spine.

---

### 4.13 Themes

A theme is a preset look laid over a book's metadata, not a section of it:
nothing in `metadata.json` records which theme a book has. The themes are an
array in `templates/themes.json`, shown in name order, each
`{ slug, name, description, fonts?, elements?, numbering?, running? }`, read by
`metadata/themes.ts`.

**House = template.** Each theme is written as overrides on the House look: the
`fonts`, `elements`, `numbering` and `running` of `templates/metadata.json`.
House itself is `{}`, so a new book and House can never disagree. A theme's look
is House deep-merged with its overrides: objects merge key by key, arrays and
strings replace, and `null` deletes the House key.

**What a theme owns.** Applying a theme changes only these, and replaces them
rather than mixing with the book's:

- `fonts` — the look's aliases are set; the book's other aliases (`mono`, any
  alias an `is` style uses) stay.
- `elements` — each element the look names replaces the book's entry for it
  wholesale. Elements it doesn't name stay.
- `numbering` — `chapters` and `parts` `style`/`prefix`/`suffix`; `pages`
  `css`/`position`/`gap`, `openers.position`, and each zone's `style`. These are
  cleared first, so a key the look leaves unset falls back to the renderer's
  default (Caslon's folio in the head goes back to the foot under House). Never
  any `show`: whether numbers appear is the book's choice. A zone's own `css`
  stays.
- `running` — replaced wholesale.

Never touched: `page`, `is`, `notes`, `toc`, `ebook`, `language`, `name`,
`spec`, and any key this schema doesn't know.

**A new book** can start from any theme: its `metadata.json` is the template
with the theme applied (§7.9). House, or no theme, is the template as it is.

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

- `loadMetadata(bookDir: string): Promise<Metadata | null>` in `loader.ts`,
  applying `upgrade.ts`'s on-load schema upgrades so a book written against an
  older shape keeps working and converges on the current one when next saved.
- `Metadata` type tree in `types.ts` mirrors §4's schema one-to-one
  (`PageConfig`, `Elements`, `Numbering`, `Running`, etc.).
- `page-setup.ts` resolves a `page` section into the full physical setup of §4.3
  — sizes parsed, named setups matched, imposition derived, unusable
  combinations named. Pure and free of Deno APIs so the browser-side
  configuration panel and the print exporter share it (§7.5, §7.7).
- `css-generator.ts` exports three functions, all consumed by both preview and
  export since Paged.js is the single pagination engine (§6):
  - `generatePagedCSS(metadata, { bookTitle }): string` — `@page`, numbering,
    and margin-box rules targeting Paged.js, reading the page map's CSS
    variables for folios and running heads (§4.7, §4.8).
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
- `epub-export.ts` — **e-book export** (§7.8). The same `render()` output,
  without Paged.js: split at the article's top-level blocks into XHTML documents
  and zipped as EPUB 3. Reflowable, so nothing from the page map applies.

**Page map and the multi-pass driver.** Paged.js only fragments; folios, TOC and
`{ref}` numbers and running heads come from the page map (§4.7) that
`renderer/folios.js` builds from the finished pages. TOC and ref numbers are
written into the flow before layout from a _seed_ (anchor id → folio text), so a
render is only right once the folios it produces are the ones it was seeded
with. `toHtml` (shared by `bml render` and print export) sets
`PagedConfig.auto = false` and inlines a driver that runs on load: it takes the
book's `<style>` and body once, then renders with a fresh `Paged.Previewer` per
pass — first seed `{}`, each next pass seeded from the last — until the seed
settles (normally two passes), at most three. It then sets
`html[data-paged=done|error]` and a JSON report in `html[data-paged-report]`:
`{ problems, passes, digest }`.

**Checks** run on the map after every pass; each problem names its 1-based
physical page where it has one:

- a stranded page: no text and no image, and not a deliberate blank;
- a `{ref}` or TOC target that is on no page;
- the book's last anchor on no page — the render was cut short;
- no fixed point after three passes.

Some checks are **warnings**, listed with the rest but never blocking an export:

- a margin box (running head or folio) that runs to a second line, measured
  against the same box held to one line (§4.8);
- an illustration whose image prints under 200 dpi at its laid-out size (its
  pixel width over its width in CSS inches), as "<slug> prints at <N> dpi (300
  looks sharp)"; vector art (SVG) has no resolution and is never warned;
- an illustration with no image — its placeholder (§4.10 item 8) or a file that
  won't load — as "an illustration has no image (<slug>)".

Print export fails on any other problem, listing each as `page N: message`,
before `book.pdf` is written; `bml export --force` prints them as warnings and
exports anyway.

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
  because every other feature depends on it. Updates are version-tagged: a
  client ignores versions its buffer already reflects, reloads silently when it
  has no unsaved edits, and otherwise shows a changed-on-disk banner (Reload /
  Keep mine); a save based on a stale version is refused (409) rather than
  overwriting.
- **Saving:** the service answers after it writes; there is no server-side
  debounce, and a failed write is that save's own error. A store's `watch`
  reports every change, its own writes included. Tabs over one library (the
  browser's folder or private storage) hear each other through a
  BroadcastChannel named for the library, and each version check + write runs
  under a lock (`navigator.locks`), so two tabs cannot both pass the check. The
  client keeps one save in flight per channel (manuscript, metadata) and shows
  "Saved" only when every channel is idle with nothing pending, failed or in
  conflict; a failed save keeps its edit and retries. Switching book or edition
  waits for saves; closing or hiding the tab sends them, and prompts while any
  remain.
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
+---------------------------------------------------------------+
| [Contents] Book · Edition  Write|Style|Publish  theme [Pages] |
+-----------+----------------------------+----------------------+
|           |                            |                      |
|   where   |   what you're changing     |      the result      |
|  you are  |                            |                      |
+-----------+----------------------------+----------------------+
```

Three columns under a fixed toolbar, decided by one rule: **left is where you
are, middle is what you're changing, right is the result.** The toolbar's mode
switch (Write ⌘1, Style ⌘2, Publish ⌘3; ⌘, also opens Style) picks all three,
and the mode persists across reloads:

| Mode    | Left                    | Middle                               | Right                            |
| ------- | ----------------------- | ------------------------------------ | -------------------------------- |
| Write   | outline (§7.2)          | BML editor (§7.3)                    | preview (§7.6)                   |
| Style   | book settings and parts | the chosen part's styles (§7.4)      | preview (§7.6)                   |
| Publish | print and e-book rows   | page setup, print and e-book exports | the first signature as it prints |

The toolbar holds only what is global: the Contents toggle at the far left
before the crumb (⌘\), drawn as a panel icon whose side is half filled while the
left column shows; the crumb; the modes; and the light/dark toggle alone at the
right. In Write the pages hide with ⌘. (no button; while they are hidden the
write pane's corner button reads "Show the pages" and brings them back); Style
and Publish always show them. Both choices persist. The crumb reads library /
book / edition. The library step, muted so the title leads, is an icon for where
the books live (a folder on this device, or this browser) and its name (the
folder's, or "This browser"); its tooltip says where, and a click goes back to
the Welcome (§7.9) to pick another. The dev server has only its `books/`, so
there the crumb starts at the book. Gutters between the columns drag to resize
them. A hidden preview still lays out (it leaves the grid, never
`display: none`), since Paged.js paginates by measuring.

Each pane carries its own controls in a header along its top: the write pane
(Write's middle column) has Prose | Source, Aa and Spelling (the text view,
§7.3), the pages pane (the right column in every mode) none yet. Both headers
end in an expand button at the top right corner:

- **Writing expanded** (Write only): the outline and the pages leave and the
  text centres at its measure. While typing, the toolbar, footer and pane header
  (all but the expand button) fade, and return when the mouse moves.
- **Pages expanded** (any mode): the pages, or Publish's sheet view, take the
  whole width; the middle column leaves.
- In either, the mouse at the left edge slides the left column in over the view,
  and the Contents toggle pins it there.
- The same button or esc returns (esc first closes an open dialog, find bar or
  menu). ⌘⇧↩ expands the pane last used, or returns (⌘⇧F stays Footnote). The
  expanded pane is remembered per mode.

### 7.2 Project Tree

Write's left column. Reflects the `BmlDocument` tree (§5.1) directly, grouped
under Front matter, Chapters and Back matter headings: front matter blocks,
parts with their chapters nested under them (§3.2.3), back matter blocks. Each
row is labelled by its `{title}`, falling back to the slug for a chapter and the
humanized matter type for matter ("Half title"); the half title and title page
always show their type, since their title is the book's. The book switcher sits
in the toolbar. Clicking a node scrolls the editor to and highlights the
corresponding source range, and scrolls the preview pane to the corresponding
page. The tree is read-only with respect to structure in v1 (reordering/dragging
nodes is out of scope, §8) — it is a navigation aid, not a structural editor.

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
- Sentinels are styled by closing form (§3.2.3), one rule: nesting-close lines
  (`matter`, `part`, `chapter`) get a faint band, a hairline above and a gutter
  mark; explicit-close pairs (`quote`, `poem`, `is`, …) are joined by a 1px rail
  from opening to closing tag, so an unclosed block shows at a glance; every
  other sentinel line (`{title}`, `{author}`, `{heading}`, `{break}`,
  `{illustration}`) is small and muted; `{em}` tags dim while their text is
  italic. The line after `{title}`, `{heading}` or `{subheading}` is bold, after
  `{subtitle}` italic. A `%%` line of only box-drawing characters draws as a
  hairline rule, and a `%%` label between two rules as small caps.
- The selection is a green-grey tint, distinct from the quieter active line.
- The text view (in the write pane's header, §7.1) is a per-reader preference in
  localStorage, not part of the book. Two views of the same file, switched by
  **Prose | Source** or ⌘/: **Source** sets every line in the system monospace
  at 13/17 of the reader's size, with the sentinel treatments above; **Prose**
  (the default, `web/src/prose.ts`, design-language.md §8.1) sets the writing in
  the chosen face and draws the markup instead of showing it: each sentinel is a
  red small-caps rubric in the left margin (a structural one with its slug
  beneath and a hairline across the text), the line after `{title}` or
  `{heading}` is large, after `{subtitle}` italic, `{em}` text italic, quotes
  and poems indented, `{break}` a ⁂, and `%%` notes a ☞ in the right margin that
  reads on hover. Outside the paragraph holding the cursor the sentinel lines,
  `%%` lines and `{em}` tags fold away; in it they show in place, in monospace,
  so everything stays editable. Clicking or arrowing onto a rubric row or a ⁂
  moves the cursor into that block and so reveals it. An `{illustration}` whose
  file is in `images/` draws its image (at most 12rem tall) above its line, its
  caption in italics beneath, and stays drawn while its markup shows. Plates,
  drop-cap images, illustrations whose file is missing, and footnote and ref
  tags stay as markup. This replaces Hide markup. The **Aa** menu holds the face
  (Alegreya, Alegreya Sans, or the book's body face), the size (12–24px, default
  17), dim (Off, Paragraph, Sentence) and page turns (on). Dim, in either view,
  fades all the text but the cursor's paragraph, or but its sentence (one ends
  at `.`, `?` or `!`, with any closing quotes, before a space or the line's
  end); the margins stay. Page turns put a short rule and the page number in the
  right margin beside the block each printed page begins in, from the last
  layout; a paragraph edited since hides its turn until the next layout lands.
  The text holds a reading measure of about 70 characters (36em), centred in the
  pane while the pages are hidden or the writing expanded. Expanded, the writing
  grows by 19/17 and the measure with it, and Prose's margins widen so notes are
  written out beside their line (which grows to hold them), page turns read "p.
  12" and slugs show in full on up to two lines.
- The preview follows the cursor: the rendered block the cursor's line is part
  of (the nearest `data-line` at or above it) is outlined and scrolled into
  view, so the writer sees where they are on the page. The footer is split by
  column: under the editor, the writer's cell (the chapter at the cursor, the
  word count and the words added this session — "Marley's Ghost · 41,210 words ·
  +512 this session", the last in red once it is above 0 — then parse warnings,
  import notes, and "Go to style:" naming the style that block belongs to —
  "Chapter · Title", "Body text · Paragraph", a custom `{is}` name); under the
  pages, the page count and page problems. Go to style opens that style in Style
  mode, the way a preview click does (§7.4), and leaves a history entry, so Back
  returns to Write with the cursor where it was. The style is read from the
  enclosing matter type, part or chapter, the enclosing block, and the field
  sentinel whose text runs on to the line.
- Find and replace is a bar pinned to the top of the editor, in the chrome's
  colors: find and replace fields, match case / whole word / regex toggles, an
  "n of m" count, previous / next / close, Replace, All, and an "in chapter"
  scope that limits Replace All to the structural block under the cursor. The
  current hit is outlined; other hits are tinted.
- Spell check underlines (wavy, `--err`) prose words that are in neither the
  English word list (SCOWL, vendored at `vendor/scowl/en.txt`, US and British
  spellings) nor the book's `dictionary.json`, `{ "words": [...] }`, shared by
  every edition. Markup, `%%` comments and the word being typed are skipped. A
  lowercase entry matches any capitalization; a capitalized one (a name) needs
  its capital; a possessive is checked without its `'s`. Hovering an underlined
  word offers up to five suggestions and **Add to dictionary**, which writes the
  word (a possessive as its name) to `dictionary.json` through
  `POST /api/books/:book/dictionary` with `{ word }`. **Spelling** in the write
  pane's header is a menu of the word lists, English (the default) or None, kept
  with the reader's other text view choices; each language is one list in
  `vendor/` and a row in `WORD_LISTS` (`text-view.ts`), and `dictionary.json` is
  the same whatever the language.
- **EXPERIMENTAL:** `{only}` spans (§3.2.9) carry an amber mark on every line's
  gutter and a tag naming their editions; lines the open edition skips are
  dimmed.
- Sentinels are inserted from inside the editor, never a toolbar menu. Every
  insertion writes the correct open/close pair for the sentinel's closing form
  (§3.2.3) and selects its placeholder; where a snippet has a slug and a title
  (or content), Tab moves from the slug to the title.
  - Typing `{` offers completions grouped as Structure, Blocks and In the
    paragraph; each row shows the name, a description, and how it closes
    (`{/quote}`, "wraps", "point", or "—" for none). Blocks include `{only}`,
    marked experimental.
  - A selection the writer makes shows a wrap bar above it: Emphasis (⌘I) wraps
    it in `{em}…{/em}`, Quote encloses its lines in `{quote}`/`{/quote}`,
    Footnote puts a `{footnote: slug}` anchor after it, and Wrap in… opens the
    full list.
  - ⌘K lists every sentinel, filtered by name or description; Enter inserts it,
    enclosing the selection for wraps and closed blocks, else placing it after
    the selection.
  - Per-sentinel shortcuts remain (em ⌘E, chapter ⌘⇧C, heading ⌘⇧H, footnote
    ⌘⇧F, quote ⌘⇧Q, break ⌘⇧B), in Write only.
- Image files dropped or pasted on the editor go in the book's `images/`
  (`POST /api/books/:book/images`, named for the file, never over one already
  there) and come back as `{illustration: slug}` / `Caption` blocks, one per
  file in drop order, at the nearest paragraph break (for a paste, the end of
  the cursor's paragraph), with a blank line either side and the first `Caption`
  selected. While a file is dragged over the editor a line marks that break,
  labelled "Drop to add an illustration here". The writer's footer says "Added
  to the book's images as <name>", or why a file was refused ("Only PNG, JPEG,
  WebP or SVG images can go in a book") and nothing goes in for it. A drag with
  no files (moving text) is CodeMirror's own, and so is a paste that carries
  text beside its files (Word and Pages copy a picture of the text with it). A
  file dropped anywhere else in the app is ignored, never opened in the tab. The
  image and the save that names it paginate once: the service holds a rebuild
  for a change to `images/` alone a moment, and the next change to the book
  takes it along.
- In the slug of `{illustration: …}` or `{dropcap | image: …}`, completions list
  the book's `images/` under "Images in this book": a small thumbnail, the slug,
  and "Not in the text yet" for an image no `{illustration:}` or `image:` in the
  manuscript names. The last row, "Add image from your computer…" ("Copies it
  into the book's images folder"), opens a file picker (PNG, JPEG, WebP, SVG),
  puts the file in `images/` as a drop does, and writes its slug; a refusal goes
  to the writer's footer. After `placement:` in an `{illustration}` tag the list
  offers `full-page` ("a page of its own") and `inline` ("in the text"), the
  placements that lay out.

### 7.4 Sentinel Styling

A visual layer over the _existing_ `metadata.json` schema (§4) — no new file
format, no new schema. In Style, clicking a sentinel's rendered output in the
preview opens its style in the middle column; in Write the same click moves the
editor cursor to its manuscript line (the nearest rendered block's `data-line`).
Page furniture (page numbers, running heads) has no source line, so a click on
it always opens its style, switching to Style. The hover outline shows only
where a click would style: everything in Style, only furniture in Write. From
the editor, Go to style in the writer's footer (§7.3) opens the same style the
preview click would for that block.

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
and `notes` sections (§4.3, §4.4, §4.7–§4.9) — replacing hand-editing JSON for
the settings that apply to the whole book rather than one sentinel type. Its
style settings are Style's columns and its print settings Print's (§7.1).
Includes:

- Page setup as one unit (§4.3): the book page size (named presets and custom
  dimensions), its margins, the sheet, folios per signature (or a booklet),
  duplex, and for backs printed by hand the flip and back order — with the
  derived imposition (pages across a sheet, folios and cuts per sheet, sheets
  per signature, leftover paper) shown live as those change, and an unprintable
  combination reported here rather than at export time
- The first signature drawn as it prints: each sheet's front and back with the
  book pages that land on it, folds dashed, cuts solid, from the same `impose()`
  export uses
- The Publish view grouped by what the author is making: **Binding** — Paper
  (the page size, with a link to Style's Page view that Back returns from, and
  the sheet), Folding (the fold, Auto naming its pick, and what the setup
  derives to), Signatures (hidden for loose leaves), and Print (auto duplex or
  by hand, the by-hand flip and back order, and the Print sheets buttons, §7.7);
  **PDF**, the pages in reading order at the page size, one per printed page
  (Print pages; Save as PDF gives the file `book.pdf` would be); and **E-book**
  (Export EPUB, §7.8). All printing runs in the browser; proofs and the sheet
  PDFs on disk are `bml
  export`'s
- Font aliases (name → font family, with a searchable picker over every Google
  family and the fonts installed on this Mac, each drawn in its own face, and a
  warning under a family that is neither; §4.4)
- Chapter/part numbering style, prefix/suffix, show/hide
- Running header/footer entries per margin box, odd/even
- Note placement: footnotes vs. endnotes (§4.9)
- A **Theme** view, first in Style's Book group: a grid of cards, one per preset
  theme (§4.13), each drawn in the theme's own fonts (its name in the display
  face, a chapter label, a line of body text and the description), in name
  order. When the book's look matches no theme (applying any would change it), a
  **Custom** card comes first, drawn in the book's own style and naming its
  fonts. The pressed card is the previewed theme, or with none the book's own:
  Custom, or the theme it matches; clicking that card discards. Clicking a card
  previews the theme: the preview shows the book built with the theme applied
  and nothing is saved. A row stuck to the top of the Theme view, next to the
  cards, reads "Previewing {Theme}" with **Apply…** and **Discard**. While a
  theme is previewed, live updates are held rather than shown; a manuscript
  change rebuilds the previewed theme with the new text. Discard, leaving the
  Theme view, switching mode or switching edition ends the preview and shows the
  newest build of the book's own style. Clicking another card switches the
  preview to that theme.
- **Apply…** always asks first, in an in-page dialog: "Apply {Theme} to
  {edition}? Fonts, part styles, chapter numbering and running heads change.
  Page size, margins and your custom styles stay." Its choices:
  - **Apply as new edition** (the recommended one): the current edition stays as
    it is; a new named edition (slug from the theme, de-duplicated: `caslon`,
    `caslon-2`, …) is copied from it with the theme applied, and the app
    switches to it.
  - **Replace this edition's style**: the theme's `fonts`, `elements`,
    `numbering` and `running` replace the edition's, saved like any panel edit
    (version checks and the changed-on-disk banner apply). It can't be undone.
  - **Cancel** closes the dialog and keeps the preview.

### 7.6 Preview Pane

The right column in Write and Style (§7.1): the live, print-accurate spread
view, under the pages pane's header, whose corner button expands it to the whole
width (§7.1).

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

A re-render is staged over the pages on screen, which stay up but dimmed from
the moment of the edit; each new page lands over the old one it replaces as it
is laid out, with a "Setting type… N pages" count at the pane's foot (the first
load shows the count alone). The layout keeps going in a background tab. An
update that arrives mid-render abandons that render and starts its own, so a run
of edits costs one render after the last, not one per edit.

An illustration whose image is missing shows its placeholder (§4.10 item 8). In
Write, a click on it moves the editor's cursor to its line, as any page click
does, then opens the file picker; a file dropped on it is taken too. Either way
the file goes in `images/` under exactly the placeholder's slug (its extension
from the file), and the rebuild shows the image. Any slug safe as a file name
can be filled (`orchard.1943`, `Orchard 1943`); one that is empty, starts with
`.`, or holds `/`, `\` or a control character is refused. A slug is taken only
by a file the renderer can show (a `harbour.tif` doesn't block `harbour`). A
taken slug or a refused type is reported in the footer note. In Style the
placeholder is the illustration's style target like any other part.

Every illustration under 200 dpi at its laid-out size, and every placeholder, is
a page-map warning in the page problems (§5.4). While the editor's cursor is on
an illustration — its `{illustration}` line or its caption line — the footer
note says "Prints at N dpi here; 300 looks sharp", in the warning colour below
200.

### 7.7 Page Setup & Print Imposition

The one subsystem with no analogue in §5's other modules — a new algorithm, not
an adaptation of existing logic. This is where "book pages" (the trim size the
manuscript is laid out at, e.g. 5.5in × 8.5in) get imposed onto physical
"sheets" (what the printer/binder actually prints on, e.g. US Legal) for
hand-binding.

**Configuration** (from `metadata.json`'s `page` section, §4.3): `sheet`, `fold`
and `folios-per-signature`, resolved together with `size` by
`metadata/page-setup.ts`.

**Binding model.** A **folio** is one folded piece of paper: 2 leaves, 4 book
pages, folded down the spine. Folios nest inside one another to form a
**signature** of `folios-per-signature` folios (= `folios-per-signature` × 4
book pages); the book is a sequence of signatures. `fold` says how a printed
sheet becomes folios:

| `fold`   | The sheet                                   | Grid             | Pages a sheet |
| -------- | ------------------------------------------- | ---------------- | ------------- |
| `folio`  | folded once, down the spine                 | 2 × 1, landscape | 4             |
| `quarto` | folded twice: head, then spine              | 2 × 2, portrait  | 8             |
| `octavo` | folded three times: spine-wise, head, spine | 4 × 2, landscape | 16            |
| `cut`    | cut into pieces, each folded once           | derived, below   | 4 × pieces    |
| `leaves` | cut into single leaves, no fold             | derived, below   | 2 × pieces    |

**True folds** (`folio`, `quarto`, `octavo`) halve the whole sheet each time, so
each page gets an equal cell of the sheet (`sheet ÷ grid`) and a page must fit
its cell. Each fold takes one half **back** behind the other, with the printed
front facing the folder: "v" folds take the left half behind the right, "h"
folds the top half behind the bottom; folio is v, quarto h v, octavo v h v. The
last fold is the spine. Folds that end up at the head or fore edge (quarto's
head; octavo's head and fore edge) join leaves that must be slit before sewing,
and are trimmed away. A folded sheet carries `cols × rows / 2` folios that nest
as one, so a true fold rounds `folios-per-signature` up to whole sheets, and
several folded sheets nest one inside the next. A quarto's head-to-head rows
mean its top row prints upside down; so does an octavo's.

**Cut then fold** (`cut`) tiles the sheet in a grid of `cols` × `rows`: `cols`
is the largest **even** number of page-widths that fit across the sheet, `rows`
the number of page-heights that fit down it, evaluated in **both sheet
orientations** with the one yielding more pages winning. A tie goes to the
single-row landscape layout, which needs fewer cuts. Each pair of columns is one
folio, so a sheet carries `rows × cols/2` folios, separated by `rows − 1` cuts
across and `cols/2 − 1` cuts down each row — `rows × cols/2 − 1` cuts in all —
each piece then folded once down its center.

- 2 × 1 — no cut: the same sheet as `folio`.
- 4 × 1 — the sheet is cut at its vertical center and each half folded; one
  sheet = two folios. The page is a narrow strip of the sheet.
- 2 × 2 (**quartering**) — the sheet is cut at its horizontal center and each
  half folded. Both sheet dimensions are halved, so the page keeps the sheet's
  proportions: US Legal 8.5in × 14in quarters to 4.25in × 7in, and the sheet
  prints portrait rather than landscape. `quarto` gets the same page from the
  same sheet without the cut.

**Loose leaves** (`leaves`) tile the sheet like `cut` but any number across, odd
included: nothing folds, every piece is one leaf (its front the recto, its back
the verso), for stab, Japanese or glued bindings. There are no signatures.
Sheets are imposed **cut and stack**: slot _s_ of sheet _t_ carries leaf _s_ ·
_N_ + _t_ (_N_ sheets), so cutting the printed stack along the grid and piling
the pieces in slot order — top row first, left to right — gives the leaves in
reading order.

**With no `fold` set** the setup takes the option that puts the most pages on a
sheet side, a true fold winning a tie with `cut` (so a quartered sheet folds as
a real quarto, and a half sheet is a folio either way). `leaves` is never
picked. If nothing fits two book pages, export fails with a clear configuration
error, as does a `fold` whose cell the page does not fit.

Example, on US Legal: a 3.5in × 4.25in page is an octavo (16 pages a sheet); a
4.25in × 7in page a quarto (8); a 3.5in × 8.5in page gives `cut` 4 × 1 strips
(also 8 pages, but a very different book); a 5.5in × 8.5in page a folio (4).

**Imposition algorithm (`server/imposition.ts`, Plan 5):**

1. Take the total page count from the Paged.js-paginated document (§5.4); pad
   the final signature with blank pages up to a multiple of
   `folios-per-signature` × 4 (loose leaves: to whole sheets). When the book
   ends in `{matter: colophon}`, its page is pinned to the final page of the
   signature (the last verso) and the blanks go before it, after the body's last
   page.
2. For each signature of _F_ folios (_P_ = 4_F_ local pages), assign pages to
   folios by the standard nesting mapping — folio _k_ (1 = outermost) carries,
   on its front face, local pages [_P_−2_k_+2 | 2_k_−1] (left | right of the
   fold) and, on its back face, [2_k_ | _P_−2_k_+1] — so that folding and
   nesting reconstructs reading order. (Check, _P_ = 16: folio 1 is [16 | 1]
   front, [2 | 15] back.)
3. Pack folios onto physical sheets. `cut`: row-major, `cols/2` folios per row.
   True folds: by simulating the folds on one sheet and reading the folded stack
   as leaves (layer _i_ carries local pages 2_i_+1 facing and 2_i_+2 away),
   which gives the standard formes — quarto front [5↓ 4↓ | 8 1], back [3↓ 6↓ | 2
   7]; octavo front [5↓ 12↓ 9↓ 8↓ | 4 13 16 1], back [7↓ 10↓ 11↓ 6↓ | 2 15 14 3]
   (↓ upside down, top row first). Nested folded sheets take the signature's
   leaves from the outside in: the outermost sheet carries its first and last
   `cols × rows` leaves. Back-side layout follows `page.duplex`, whose effect
   depends on the sheet orientation the grid chose: turning the sheet about a
   left/right edge mirrors the folio **column** order (each `[2k | P−2k+1]` pair
   intact), turning it about a top/bottom edge mirrors the **rows** — which is
   that same layout rotated 180° as a whole. Those left/right edges are the
   short ones on a landscape sheet and the long ones on a portrait sheet, so
   `short-edge` mirrors columns on a 2-up landscape job and rows on a quartered
   portrait one. The exporter maps this; `duplex` always names the setting to
   pick on the printer.
4. Place each page. `cut` and `leaves` pack the pages edge to edge, the grid
   centred on the sheet. A true fold puts each page against the spine edge of
   its cell (a recto's left, a verso's right, swapped when it prints upside
   down), centred head to tail, so every leaf registers on the spine fold and
   the slack is trimmed from the fore edge, head and tail.
5. Emit the final print file via `print-export.ts` (§5.4, §6) — one output page
   per sheet side, at the sheet's physical dimensions, with the
   already-paginated book pages positioned at their exact trim size.

**Output:** one `sheets.pdf` (or `sheets-fronts.pdf` + `sheets-backs.pdf` for
`duplex: none`), built by embedding `book.pdf` pages onto sheet-sized PDF pages;
`--proof` emits numbered placeholders for a one-sheet printer check (a booklet's
proof needs `--pages`, the book's page count). The files land in
`books/<book>/export/` (or `export/<edition>/`).

**Printing from the browser** (`web/src/print.ts`): the Publish tab's Print
sheets button needs no Chrome on the server. It clones the live preview's
Paged.js pages onto sheet-sized print layers laid out by the same `impose()` and
`sidesFor()` the exporter uses (one layer per sheet side, pages at their trim
size, rotated slots turned 180°), overrides `@page` with the sheet size, and
opens the browser's print dialog; `afterprint` removes the layer. A printer gets
the sheets directly; Save as PDF gives the same file as `sheets.pdf`.
`duplex:
none` is two runs, Print fronts and Print backs, honouring `flip` and
`reverse-backs`. Print pages is the same layer with a 1 × 1 grid at the page
size and no imposition. Chrome and Edge; proofs stay with the exporter.

### 7.8 E-book Export

`bml epub <book> [--edition e] [--out dir]`, or the Publish tab's E-book
section, writes `book.epub` beside the print files in `books/<book>/export/`
(the dev server runs it behind `POST /api/books/<book>/epub`). An EPUB is a zip
of XHTML documents with a package file and a navigation document, and is
**reflowable**: the reader chooses the page size and font, so folios, running
heads, sheets and signatures have no meaning in it, and the page map (§5.4) is
not consulted.

**What it reuses.** The same `render()` output as print, with notes forced to
endnotes (there is no page foot to float to), the base CSS and the metadata's
element CSS. Font links are dropped: readers block remote resources and
substitute their own faces. Images referenced by the render are copied in.

**Documents.** The article is split at its top-level blocks: each matter block,
each chapter outside a part, and each part with its chapters becomes one XHTML
file, with the block's endnotes kept in it. HTML5 void tags are self-closed; ids
are mapped to files so `href="#slug"` links cross documents.

**Navigation.** The TOC rows (§3.4.6) become the EPUB 3 nav document, nested
parts → chapters → headings. When the book has a `{matter: toc}` block, that
block's document _is_ the nav (its title kept, the printed rows replaced by the
list) at the same place in the reading order; otherwise the nav exists for the
reader's menu only.

**Notes and refs.** Each `{footnote}` anchor is an `epub:type="noteref"` and its
note an `epub:type="footnote"`, so readers that support it pop the note up. A
`{ref}` has no page number to resolve to: it renders as a link whose text is the
target's contents label (its title, else its number, else its slug). Prose
written around a page number ("on page {ref: x}") should use edition spans
(§3.2.9) to word the e-book differently.

**Metadata.** Title from the title page, author from its `{author}`, and the
`ebook` section (§4.12) for identifier, language and cover.

### 7.9 First Run & Import

A new user has no books and does not know BML. The first run is a short sequence
of one-question dialogs, and an imported manuscript is itself the tutorial: the
user lands in Write mode looking at their own words wrapped in the tags,
paginated in the house template, with the importer's notes in the footer. There
is no settings form; the editor is the review step.

**Welcome — where books live.** Shown when the app has no library. Four rows,
each one line of explanation, in the manner of a session-type picker:

1. Create a new folder on my device — Wynkyn creates a Books folder.
2. Select an existing folder on my device — the user already has one.
3. Keep books in this browser — works anywhere, but browsers clear site storage,
   so download what you want to keep.
4. Save books in the cloud — paid, coming soon, disabled.

Under the rows, the privacy line: _Your books are yours. Wynkyn never reads,
analyses, trains on, shares or sells your manuscripts, and never will. Free
users store everything on device._ Rows 1 and 2 need the File System Access API
(Chrome, Edge, Brave); row 3 is the fallback everywhere.

**Create a new folder.** A location picker and a folder name (default `Books`),
with the resulting path shown. Then _Create a new manuscript_.

**Select an existing folder.** The native picker, then permission to edit. A
folder holding books (`<slug>/manuscript.md`) shows **Choose a book**: title,
chapter count, page count, last edit, and a _New manuscript…_ button. An empty
folder goes to _Create a new manuscript_.

**Create a new manuscript.** Three rows: _Import a file_ (Word, EPUB, plain
text, Markdown, HTML), _Import from the web_ (a Project Gutenberg book, a shared
Google Doc, a web page), _Start blank_. The book switcher's _New manuscript…_
opens the same dialog once a library has books.

**Import from the web.** One address field and _Fetch_. The page fetches the
address itself when the site lets a web page read it (Standard Ebooks,
Wikisource). When it doesn't (Project Gutenberg, the Internet Archive) the same
dialog shows the paste step: open the address in a new tab (a Gutenberg link
opens as its plain-text file), select all, copy, and paste into the box; the
paste imports at once. The clipboard's HTML is used when it has paragraphs or
headings, else its plain text. EPUB is file-only. The title dialog shows the
address and the manuscript's summary comment names it.

**Choose a book title.** One dialog for all three. Imports show their source
(file name and size, or the address) above the title field and prefill the title
from the file's metadata, falling back to the file name; blank starts empty. The
folder slug is shown live under the field and the book can be renamed later. The
button reads _Import_ or _Create book_. Under the folder line a **Theme** row of
small cards, one per theme (§4.13) in its own fonts, in name order, House
picked; the line under them names the picked theme and describes it. The new
book's `metadata.json` is the template with that theme applied, the same as
`bml new <slug> --theme <t>` and `bml import <file> --theme <t>` (an unknown
theme is an error, never House; a re-import keeps the existing `metadata.json`).
Blank then opens the editor on a half-title page carrying the title.

**No wizard.** An import always makes its best guess and opens the editor; the
editor and preview are the review step. Structural decisions the detector could
not settle (two heading patterns that both fire, verse or hard-wrapped prose)
are not asked up front, when a new user cannot answer them, but offered
afterwards: the import notes list opens with _Read it differently_ and the two
or three alternative readings as pills. Picking one re-imports from the source
file and replaces the manuscript, so re-import is the undo for a lossy choice
such as reflowing verse. The section appears only when a second reading was
plausible; most books never see it. Everything line-local is a `%% check:`
comment, never a question.

**The imported manuscript.** The importer writes BML in the house shape of the
`convert-manuscript` skill (half-title, title page, copyright, toc, chapters
with `{dropcap}`, colophon). A `%%` block at the top says what it did (chapters
found and how, italic runs made `{em}`, what was dropped, illustrations copied)
and that `{` shows every tag. Each guess gets a `%% check:` comment on the line
above it; the footer lists them as "N import notes to check", click to jump, and
the user deletes the comment when satisfied. BML's one inline tag means bold,
underline and small caps become `{em}` or plain text, and the summary says so.

**Pipeline (the design, not yet built).** Runtime-agnostic like `buildBook`
(§5.4), so it runs in the page and in Deno: one reader per format emits the same
flat block stream (heading with level, paragraph, verse lines, quote, break,
image, note); one detector turns the stream into parts, chapters, front and back
matter; one emitter writes the BML. Readers: text and Markdown (trim Gutenberg
START/END markers, join hard-wrapped lines, `_x_` to `{em}`, `[Illustration:]`,
`* * *` to `{break}`); HTML (a DOM walk: h1–h6, p, blockquote, em/i, br, img,
hr); EPUB (fflate, the OPF spine through the HTML walker, nav/NCX titles as the
chapter filter, images to `images/`); DOCX (fflate, `word/document.xml`
paragraph styles and italic runs, `footnotes.xml` to `{footnote}`/`{note}`,
`word/media` to `images/`, skipping ornaments laid behind or over the text; a
document with no heading styles has its headings read from their look, a short
line set larger than the body text or all in bold, and one with them its volumes
and parts set that way; the first run of Title lines is the book's title, and a
Title line ending a section of its own is a Google Docs tab name, dropped;
tables are skipped, as in HTML). Lines ending in a dot leader and a page number
are a contents list typed by hand, in any format, and are dropped. Chapter
detection: the shallowest heading level with at least two headings; a deeper
level with twice as many headings under at most twelve shallow ones makes the
shallow ones parts; for text, "Chapter N" or `#` or standalone ALL-CAPS lines,
whichever fires at least twice. Title and author from EPUB metadata, DOCX
`core.xml` or the Gutenberg header lines. No new dependencies except deno-dom
for the CLI's HTML parsing (Deno has no `DOMParser`). Web import in the browser
is fetch-or-paste in the page, so it needs no server. PDF is out: export to Word
or text first.

---

## 8. Non-Goals

Explicitly out of scope, to bound the work below:

- Binding styles other than the §7.7 model — folio, quarto, octavo, cut then
  fold, or loose leaves (no sextodecimo or other folds past three, no
  work-and-turn or work-and-tumble layouts, no perfect binding with spine text,
  etc.)
- Font files carried with a book, or fonts embedded in an EPUB (fonts are Google
  families or installed ones, §4.4)
- Multi-user/collaborative real-time editing
- Structural editing via drag-and-drop in the project tree (§7.2) — tree is
  navigation-only in v1
- Automated table-of-contents _authoring_ beyond what the renderer already
  generates from the tree (manual TOC entry per §3.4.6 remains available as a
  fallback)
- Import from PDF (§7.9: export to Word or text first)
- Output formats other than the print PDFs (§7.7) and EPUB (§7.8); EPUB
  accessibility metadata beyond what the semantic markup gives for free

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
- **Goal:** §7.5 — forms over `page`, `fonts`, `numbering`, `running`, and
  `notes`.
- **Deliverables:** panel UI reading/writing `metadata.json`'s book-wide
  sections; live-loop re-render on save. (`page`'s sheet, folios and duplex feed
  Plan 5's export; the panel resolves them alongside `size` and shows the
  derived imposition, §4.3.)
- **Definition of done:** every field in §4.3/4.4/4.7–4.9 is editable without
  hand-touching JSON, and edits are visible in the preview immediately (the
  page-setup fields that only affect export excepted — those report what they
  derive to in the panel instead).

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
  and print-ready export, configured by `metadata.json`'s `page` section (§4.3).
  (The form UI for those settings lives in Plan 3's config panel.)
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
- **Goal:** §3.4.6, §4.5 (contents sub-elements and recipes), §4.11 — a
  generated contents page whose every visual choice is a CSS block in
  `metadata.json`, edited live in the style panel.
- **Deliverables:** row/span markup with level classes; right-anchored
  repeated-string leaders (`--leader`); zone-aware folios via
  `target-counter()`; numbers, subtitles, front and back matter, optional
  slugged headings; recursive element sub-styles; `words` numbering;
  style-catalog entries for every contents span.
- **Definition of done:** each recipe in §4.5 reproduces its layout on a real
  book in both the preview and `bml export`, with no change to the renderer.
