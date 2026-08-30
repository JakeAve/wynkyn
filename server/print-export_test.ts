import { assertEquals } from "jsr:@std/assert";
import { PDFDocument } from "pdf-lib";
import { impose, parseDims } from "./imposition.ts";
import { buildSheetPdf, sidesFor } from "./print-export.ts";

const geom = { sheet: parseDims("legal"), page: { w: 3.5, h: 8.5 }, nUp: 4 };
const imp = impose(8, { folios: 2, sheet: geom.sheet, page: geom.page, duplex: "short-edge", flip: "short-edge" });

Deno.test("sidesFor: duplex interleaves front/back per sheet; fronts/backs split; backs can reverse", () => {
  const two = impose(8, { folios: 1, sheet: geom.sheet, page: { w: 5.5, h: 8.5 }, duplex: "none", flip: "short-edge" });
  assertEquals(sidesFor(two, "duplex", false).map((s) => s.label), [
    "sig 1 · sheet 1 · front", "sig 1 · sheet 1 · back", "sig 2 · sheet 1 · front", "sig 2 · sheet 1 · back",
  ]);
  assertEquals(sidesFor(two, "fronts", false).map((s) => s.label), ["sig 1 · sheet 1 · front", "sig 2 · sheet 1 · front"]);
  assertEquals(sidesFor(two, "backs", true).map((s) => s.label), ["sig 2 · sheet 1 · back", "sig 1 · sheet 1 · back"]);
});

Deno.test("buildSheetPdf: proof mode makes one landscape sheet page per side", async () => {
  const bytes = await buildSheetPdf(sidesFor(imp, "duplex", false), geom, null);
  const doc = await PDFDocument.load(bytes);
  assertEquals(doc.getPageCount(), 2);
  const { width, height } = doc.getPage(0).getSize();
  assertEquals([width, height], [14 * 72, 8.5 * 72]);
});

Deno.test("buildSheetPdf: embeds real pages from a source PDF", async () => {
  // Source: 8 trim-size pages, each with its 1-based number drawn on it.
  const src = await PDFDocument.create();
  for (let i = 1; i <= 8; i++) src.addPage([3.5 * 72, 8.5 * 72]).drawText(String(i), { x: 20, y: 20, size: 40 });
  const bytes = await buildSheetPdf(sidesFor(imp, "duplex", false), geom, await src.save());
  const doc = await PDFDocument.load(bytes);
  assertEquals(doc.getPageCount(), 2);
  assertEquals(doc.getPage(1).getSize().width, 14 * 72);
});
