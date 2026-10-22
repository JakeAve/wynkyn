---
name: bookbinding
description: Use whenever work touches how a book becomes paper — page size against sheet size, margins, folios and signatures, imposition, duplex and flipping, page numbers and running heads, recto/verso rules, blank pages, the colophon, proofs — or when a term like folio, signature, quarto, recto, verso, trim, gutter, n-up or booklet needs the house meaning. Read it before changing metadata/page-setup.ts, server/imposition.ts, renderer/folios.js, server/print-export.ts, or the Page, Print and page-furniture panels, and before answering a question about printing or binding.
---

# Bookbinding, as this app models it

The user folds and sews the books by hand. The app's job is to put the right
book page on the right spot of a printer sheet so that folding and nesting
reconstructs reading order. Everything below is fixed in v1 (spec §8); the
geometry is derived, never configured.

## Vocabulary

| Term | Here it means |
| --- | --- |
| **Page** | one book page at trim size (`page.size`), what the preview shows |
| **Sheet** | the physical paper the printer loads (`page.sheet`) |
| **Folio** | one folded piece of paper: 2 leaves, 4 pages. The unit of signature size. *Also* the printed page number — the margin box says "folio" too; context tells |
| **Signature** | `folios-per-signature` folios nested one inside the next, then sewn as one gathering; `"booklet"` = the whole book in one signature |
| **Recto / verso** | right-hand (odd) / left-hand (even) page. The body opens on a recto; chapter and part openers may be forced recto |
| **Inside / outside margin** | gutter side / fore edge. Mirrored per recto/verso, so never say left/right in metadata |
| **n-up** | pages per sheet side: `cols × rows`, with `cols` always even |
| **Quarter** | halving *both* sheet dimensions (2 × 2): quarter legal is 4.25 × 7 in, a scaled sheet, never a 4-across strip |
| **Display page** | half title, title page, copyright, dedication, epigraph…: carries no folio or running head |
| **Furniture** | folios and running heads; sits in Paged.js margin boxes, outside the text block |

## The binding model

- All folds are vertical, parallel to the spine. A grid only adds *cuts*: a
  2 × 1 sheet folds once; 4 × 1 is cut down the middle then each half folded;
  2 × 2 is cut across then each half folded. There is no true quarto fold.
- `cols` is the largest even number of page widths across the sheet, `rows` the
  page heights down it, tried in both sheet orientations; more pages wins, a tie
  goes to the single-row landscape (fewer cuts). No fit two-up → an error the
  panel shows inline and `bml export` refuses.
- Nesting: in a signature of _P_ = 4·folios pages, folio _k_ (1 = outermost)
  carries [_P_−2_k_+2 | 2_k_−1] on its front face and [2_k_ | _P_−2_k_+1] on
  its back. Check with _P_ = 16: folio 1 is [16 | 1] front, [2 | 15] back.
- The last signature is padded with blanks to a multiple of 4·folios. When the
  book ends in `{matter: colophon}`, the colophon is pinned to the signature's
  final verso and the blanks go before it.
- Backs: `duplex` names the printer setting (`short-edge` book turn, default;
  `long-edge`; `none` = separate fronts/backs files turned by hand, with `flip`
  and `reverse-backs`). Turning about the left/right edge mirrors folio columns;
  about the top/bottom edge mirrors rows (= 180° of the whole). Which edge is
  "short" depends on the orientation the grid chose, so a quartered portrait job
  and a 2-up landscape job mirror differently for the same setting.

## Page furniture rules (Chicago)

- Folio hidden on display pages and blanks; shown on openers.
- Running head on body pages only, never on a display, blank or opener page.
- Front matter counts in roman, the body restarts in arabic, back matter
  continues the body count. A `{ref}` or contents entry uses the page's number
  whether or not its folio is printed.
- Heads and folios belong to the text block, a fixed gap above the first line
  and below the last; the margin is the white space outside all three. Raising
  a margin moves text, head and folio together.

These are read-only in the UI on purpose; `references/page-furniture.md` has
the detail and the shape an override would take.

## Before paper

A new printer, sheet or duplex setting gets `bml export <book> --proof` first:
one signature of numbered placeholders, printed, folded and nested by hand,
read in order. The one combination not yet proven on paper is `short-edge` on a
quartered portrait sheet, where rows mirror instead of columns. Then the real
export; the fore edge is trimmed after sewing, so compensate in `outside`
margin, not in `size`.

## Read next

- Spec §4.3 (`page` section), §7.7 (imposition, the algorithm and the
  `duplex` table), §4.7–4.8 (numbering and running heads), §8 (non-goals).
- `metadata/page-setup.ts` — `gridFor`, `foldedSize`, `resolvePageSetup`; the
  only place sizes are derived.
- `server/imposition.ts` — `impose()`, pure, with the nesting mapping in code.
- `renderer/folios.js` — the page map: `PageEntry` says per page whether it is
  display, blank, opener, which zone, and so which furniture it carries.
- `references/page-furniture.md` — drop rules, anchoring, override shape.
