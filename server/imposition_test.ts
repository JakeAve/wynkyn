import { assertEquals, assertThrows } from "@std/assert";
import { gridFor, impose, type ImposeConfig, parseDims } from "./imposition.ts";

Deno.test("parseDims: named sizes and explicit in/mm", () => {
  assertEquals(parseDims("legal"), { w: 8.5, h: 14 });
  assertEquals(parseDims("Letter"), { w: 8.5, h: 11 });
  assertEquals(parseDims("5.25in 8in"), { w: 5.25, h: 8 });
  const a5 = parseDims("148mm 210mm");
  assertEquals(Math.round(a5.w * 100) / 100, 5.83);
  assertThrows(() => parseDims("huge"), Error, 'unknown size "huge"');
});

Deno.test("gridFor: even columns, rows only when they earn more pages", () => {
  const legal = parseDims("legal");
  const cells = (
    sheet: { w: number; h: number },
    page: { w: number; h: number },
  ) => {
    const g = gridFor(sheet, page);
    return g === null ? null : [g.cols, g.rows];
  };
  assertEquals(cells(legal, { w: 3.5, h: 8.5 }), [4, 1]); // spec §7.7 example
  assertEquals(cells(legal, { w: 5.5, h: 8.5 }), [2, 1]); // spec §7.7 example
  assertEquals(cells(legal, { w: 4.5, h: 8.5 }), [2, 1]); // floor(14/4.5)=3 → 2
  assertEquals(cells(legal, { w: 4.25, h: 7 }), [2, 2]); // quartered
  assertEquals(cells(parseDims("letter"), { w: 5.5, h: 8.5 }), [2, 1]); // 11/5.5 exactly
  assertEquals(cells(parseDims("letter"), { w: 6, h: 8.5 }), null); // only 1 fits
  // Too tall to sit across letter's long side, but it fits 2-up down the short
  // one — a page the single-row rule used to reject outright.
  assertEquals(cells(parseDims("letter"), { w: 4, h: 9 }), [2, 1]);
});

const LEGAL = parseDims("legal");
const base: ImposeConfig = {
  folios: 1,
  sheet: LEGAL,
  page: { w: 5.5, h: 8.5 },
  duplex: "short-edge",
  flip: "short-edge",
};
const pages = (slots: { page: number | null }[]) =>
  slots.map((s) => s.page === null ? null : s.page + 1); // 1-based for readability

Deno.test("impose: one folio, 2-up, 4 pages", () => {
  const r = impose(4, base);
  assertEquals(r.nUp, 2);
  assertEquals(r.paddedCount, 4);
  assertEquals(r.signatures, 1);
  assertEquals(r.sheetsPerSignature, 1);
  assertEquals(r.sheets.length, 1);
  assertEquals(pages(r.sheets[0]!.front), [4, 1]);
  assertEquals(pages(r.sheets[0]!.back), [2, 3]);
  assertEquals(r.sheets[0]!.front.map((s) => s.folio), [1, 1]);
});

Deno.test("impose: spec §7.7 check — 4 folios, 16 pages, 2-up", () => {
  const r = impose(16, { ...base, folios: 4 });
  assertEquals(r.sheetsPerSignature, 4);
  assertEquals(pages(r.sheets[0]!.front), [16, 1]);
  assertEquals(pages(r.sheets[0]!.back), [2, 15]);
  assertEquals(pages(r.sheets[1]!.front), [14, 3]);
  assertEquals(pages(r.sheets[1]!.back), [4, 13]);
  assertEquals(pages(r.sheets[3]!.front), [10, 7]);
  assertEquals(pages(r.sheets[3]!.back), [8, 9]);
});

Deno.test("impose: sig > 0 && sheet > 0 — second signature's second sheet", () => {
  const r = impose(32, { ...base, folios: 4 });
  assertEquals(r.sheets[5]!.signature, 1);
  assertEquals(pages(r.sheets[5]!.front), [30, 19]);
  assertEquals(pages(r.sheets[5]!.back), [20, 29]);
});

Deno.test("impose: 2 folios on a 4-up sheet → one sheet, mirrored back", () => {
  const r = impose(8, { ...base, folios: 2, page: { w: 3.5, h: 8.5 } });
  assertEquals(r.nUp, 4);
  assertEquals(r.sheetsPerSignature, 1);
  // front: folio 1 [8|1] then folio 2 [6|3]
  assertEquals(pages(r.sheets[0]!.front), [8, 1, 6, 3]);
  // back (book-style flip): folio order mirrored, pairs intact: folio 2 [4|5] then folio 1 [2|7]
  assertEquals(pages(r.sheets[0]!.back), [4, 5, 2, 7]);
  assertEquals(r.sheets[0]!.back.map((s) => s.folio), [2, 2, 1, 1]);
  assertEquals(r.wastedFolioSlots, 0);
});

Deno.test("impose: pads to a signature multiple with blanks at the end", () => {
  const r = impose(13, { ...base, folios: 1 });
  assertEquals(r.paddedCount, 16);
  assertEquals(r.signatures, 4);
  const last = r.sheets[3]!;
  assertEquals(pages(last.front), [null, 13]); // page 16 is blank
  assertEquals(pages(last.back), [null, null]); // 14, 15 blank
});

Deno.test("impose: a tail page lands last, the blanks before it", () => {
  const r = impose(13, { ...base, folios: 1, tail: 1 });
  const last = r.sheets[3]!;
  assertEquals(pages(last.front), [13, null]); // page 16 is the colophon
  assertEquals(pages(last.back), [null, null]); // 13, 14, 15 blank
  // No padding to absorb: the tail stays where it is.
  assertEquals(pages(impose(4, { ...base, tail: 1 }).sheets[0]!.front), [4, 1]);
});

Deno.test("impose: odd folio count on a 4-up sheet leaves a blank folio slot", () => {
  const r = impose(12, { ...base, folios: 3, page: { w: 3.5, h: 8.5 } });
  assertEquals(r.sheetsPerSignature, 2);
  assertEquals(r.wastedFolioSlots, 1);
  assertEquals(pages(r.sheets[1]!.front), [8, 5, null, null]);
  assertEquals(pages(r.sheets[1]!.back), [null, null, 6, 7]);
});

Deno.test("impose: long-edge flip = book-style back rotated 180° as a whole", () => {
  const r = impose(8, {
    ...base,
    folios: 2,
    page: { w: 3.5, h: 8.5 },
    duplex: "long-edge",
  });
  assertEquals(pages(r.sheets[0]!.back), [7, 2, 5, 4]);
  assertEquals(r.sheets[0]!.back.every((s) => s.rotate === 180), true);
  assertEquals(r.sheets[0]!.front.every((s) => s.rotate === 0), true);
});

Deno.test("impose: duplex none uses the flip setting for the back layout", () => {
  const book = impose(4, { ...base, duplex: "none", flip: "short-edge" });
  assertEquals(pages(book.sheets[0]!.back), [2, 3]);
  const cal = impose(4, { ...base, duplex: "none", flip: "long-edge" });
  assertEquals(pages(cal.sheets[0]!.back), [3, 2]);
});

Deno.test("impose: page too wide for 2-up is a configuration error", () => {
  assertThrows(
    () => impose(4, { ...base, page: { w: 8, h: 8.5 } }),
    Error,
    "page 8×8.5in does not fit 2-up on sheet 8.5×14in",
  );
});

// ---------- quartered sheets (2 columns × 2 rows) ----------

const QUARTER: ImposeConfig = {
  ...base,
  page: { w: 4.25, h: 7 }, // legal halved on both sides
  folios: 4,
};

Deno.test("impose: a quartered sheet stacks two folios, one per row", () => {
  const r = impose(16, QUARTER);
  assertEquals([r.nUp, r.cols, r.rows], [4, 2, 2]);
  assertEquals(r.sheet, { w: 8.5, h: 14 }); // portrait: long side runs down
  assertEquals(r.sheetsPerSignature, 2);
  // Row-major: row 0 is folio 1 [16|1], row 1 is folio 2 [14|3].
  assertEquals(pages(r.sheets[0]!.front), [16, 1, 14, 3]);
  assertEquals(r.sheets[0]!.front.map((s) => s.folio), [1, 1, 2, 2]);
  assertEquals(pages(r.sheets[1]!.front), [12, 5, 10, 7]);
});

Deno.test("impose: on a portrait sheet it is long-edge that mirrors columns", () => {
  // Turning about a left/right edge mirrors columns, and on a portrait sheet
  // those are the long edges — the opposite of the 2-up landscape case.
  const r = impose(16, { ...QUARTER, duplex: "long-edge" });
  // Each row keeps its folio and its own rows: folio 1 backs to [2|15].
  assertEquals(pages(r.sheets[0]!.back), [2, 15, 4, 13]);
  assertEquals(r.sheets[0]!.back.map((s) => s.folio), [1, 1, 2, 2]);
  assertEquals(r.sheets[0]!.back.every((s) => s.rotate === 0), true);
  // Page 2 must land behind page 1: back column 0 sits behind front column 1.
  assertEquals(pages(r.sheets[0]!.front), [16, 1, 14, 3]);
});

Deno.test("impose: short-edge on a portrait sheet mirrors rows instead", () => {
  const r = impose(16, { ...QUARTER, duplex: "short-edge" });
  // The column-mirroring layout rotated 180° as a whole — rows swap, and every
  // slot turns with the sheet.
  assertEquals(pages(r.sheets[0]!.back), [13, 4, 15, 2]);
  assertEquals(r.sheets[0]!.back.map((s) => s.folio), [2, 2, 1, 1]);
  assertEquals(r.sheets[0]!.back.every((s) => s.rotate === 180), true);
});

Deno.test("impose: a quartered sheet wastes a folio slot on an odd count", () => {
  const r = impose(12, { ...QUARTER, folios: 3 });
  assertEquals(r.sheetsPerSignature, 2);
  assertEquals(r.wastedFolioSlots, 1);
  assertEquals(pages(r.sheets[1]!.front), [8, 5, null, null]);
});
