import { assertEquals, assertThrows } from "jsr:@std/assert";
import { impose, nUp, parseDims, type ImposeConfig } from "./imposition.ts";

Deno.test("parseDims: named sizes and explicit in/mm", () => {
  assertEquals(parseDims("legal"), { w: 8.5, h: 14 });
  assertEquals(parseDims("Letter"), { w: 8.5, h: 11 });
  assertEquals(parseDims("5.25in 8in"), { w: 5.25, h: 8 });
  const a5 = parseDims("148mm 210mm");
  assertEquals(Math.round(a5.w * 100) / 100, 5.83);
  assertThrows(() => parseDims("huge"), Error, 'unknown size "huge"');
});

Deno.test("nUp: derived from sheet long side / page width, even only", () => {
  const legal = parseDims("legal");
  assertEquals(nUp(legal, { w: 3.5, h: 8.5 }), 4); // spec §7.7 example
  assertEquals(nUp(legal, { w: 5.5, h: 8.5 }), 2); // spec §7.7 example
  assertEquals(nUp(legal, { w: 4.5, h: 8.5 }), 2); // floor(14/4.5)=3 → 2
  assertEquals(nUp(parseDims("letter"), { w: 5.5, h: 8.5 }), 2); // 11/5.5 = 2 exactly
  assertEquals(nUp(parseDims("letter"), { w: 6, h: 8.5 }), 0); // only 1 fits
  assertEquals(nUp(parseDims("letter"), { w: 4, h: 9 }), 0); // too tall
});

const LEGAL = parseDims("legal");
const base: ImposeConfig = { folios: 1, sheet: LEGAL, page: { w: 5.5, h: 8.5 }, duplex: "short-edge", flip: "short-edge" };
const pages = (slots: { page: number | null }[]) => slots.map((s) => s.page === null ? null : s.page + 1); // 1-based for readability

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

Deno.test("impose: odd folio count on a 4-up sheet leaves a blank folio slot", () => {
  const r = impose(12, { ...base, folios: 3, page: { w: 3.5, h: 8.5 } });
  assertEquals(r.sheetsPerSignature, 2);
  assertEquals(r.wastedFolioSlots, 1);
  assertEquals(pages(r.sheets[1]!.front), [8, 5, null, null]);
  assertEquals(pages(r.sheets[1]!.back), [null, null, 6, 7]);
});

Deno.test("impose: long-edge flip = book-style back rotated 180° as a whole", () => {
  const r = impose(8, { ...base, folios: 2, page: { w: 3.5, h: 8.5 }, duplex: "long-edge" });
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
