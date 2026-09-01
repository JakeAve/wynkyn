import { assertEquals, assertRejects } from "@std/assert";
import { PDFDict, PDFDocument, PDFName, PDFPage, PDFStream } from "pdf-lib";
import { impose, parseDims } from "./imposition.ts";
import {
  buildSheetPdf,
  exportBook,
  formatSummary,
  sidesFor,
} from "./print-export.ts";

const geom = { sheet: parseDims("legal"), page: { w: 3.5, h: 8.5 }, nUp: 4 };
const imp = impose(8, {
  folios: 2,
  sheet: geom.sheet,
  page: geom.page,
  duplex: "short-edge",
  flip: "short-edge",
});

Deno.test("sidesFor: duplex interleaves front/back per sheet; fronts/backs split; backs can reverse", () => {
  const two = impose(8, {
    folios: 1,
    sheet: geom.sheet,
    page: { w: 5.5, h: 8.5 },
    duplex: "none",
    flip: "short-edge",
  });
  assertEquals(sidesFor(two, "duplex", false).map((s) => s.label), [
    "sig 1 · sheet 1 · front",
    "sig 1 · sheet 1 · back",
    "sig 2 · sheet 1 · front",
    "sig 2 · sheet 1 · back",
  ]);
  assertEquals(sidesFor(two, "fronts", false).map((s) => s.label), [
    "sig 1 · sheet 1 · front",
    "sig 2 · sheet 1 · front",
  ]);
  assertEquals(sidesFor(two, "backs", true).map((s) => s.label), [
    "sig 2 · sheet 1 · back",
    "sig 1 · sheet 1 · back",
  ]);
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
  for (let i = 1; i <= 8; i++) {
    src.addPage([3.5 * 72, 8.5 * 72]).drawText(String(i), {
      x: 20,
      y: 20,
      size: 40,
    });
  }
  const bytes = await buildSheetPdf(
    sidesFor(imp, "duplex", false),
    geom,
    await src.save(),
  );
  const doc = await PDFDocument.load(bytes);
  assertEquals(doc.getPageCount(), 2);
  assertEquals(doc.getPage(1).getSize().width, 14 * 72);
});

const ROOT = new URL("./testdata", import.meta.url).pathname;

Deno.test("exportBook --proof: writes sheets.pdf sized to the sheet, one signature by default", async () => {
  const out = await Deno.makeTempDir();
  // demo-book is 5.5×8.5in → 2-up on legal: 2 folios = 2 sheets = 4 sides.
  const s = await exportBook(ROOT, "demo-book", {
    proof: true,
    folios: 2,
    sheet: "legal",
    duplex: "short-edge",
    out,
  });
  assertEquals(s.pageCount, 8);
  assertEquals(s.imposition.nUp, 2);
  assertEquals(s.files, [`${out}/sheets.pdf`]);
  const doc = await PDFDocument.load(await Deno.readFile(`${out}/sheets.pdf`));
  assertEquals(doc.getPageCount(), 4);
});

Deno.test("exportBook --proof --duplex none: fronts and backs files", async () => {
  const out = await Deno.makeTempDir();
  const s = await exportBook(ROOT, "demo-book", {
    proof: true,
    folios: 1,
    sheet: "legal",
    duplex: "none",
    pages: 9,
    out,
  });
  // folios 1, pages 9 → 12 padded → 3 signatures × 1 sheet each → 3 fronts, 3 backs.
  assertEquals(s.imposition.paddedCount, 12);
  assertEquals(s.files, [
    `${out}/sheets-fronts.pdf`,
    `${out}/sheets-backs.pdf`,
  ]);
  const fronts = await PDFDocument.load(
    await Deno.readFile(`${out}/sheets-fronts.pdf`),
  );
  const backs = await PDFDocument.load(
    await Deno.readFile(`${out}/sheets-backs.pdf`),
  );
  assertEquals(fronts.getPageCount(), 3);
  assertEquals(backs.getPageCount(), 3);
});

Deno.test("exportBook: rejects a folios value that isn't a whole number ≥ 1", async () => {
  const out = await Deno.makeTempDir();
  await assertRejects(
    () =>
      exportBook(ROOT, "demo-book", {
        proof: true,
        folios: 0,
        sheet: "legal",
        out,
      }),
    Error,
    "folios-per-signature must be a whole number ≥ 1 (got 0)",
  );
});

Deno.test("exportBook: rejects a non-integer pages value", async () => {
  const out = await Deno.makeTempDir();
  await assertRejects(
    () =>
      exportBook(ROOT, "demo-book", {
        proof: true,
        pages: 2.5,
        sheet: "legal",
        out,
      }),
    Error,
    "pages must be a whole number ≥ 1 (got 2.5)",
  );
});

Deno.test("exportBook: rejects an unrecognized duplex value", async () => {
  const out = await Deno.makeTempDir();
  await assertRejects(
    () =>
      exportBook(ROOT, "demo-book", {
        proof: true,
        // deno-lint-ignore no-explicit-any
        duplex: "banana" as any,
        sheet: "legal",
        out,
      }),
    Error,
    'duplex must be short-edge, long-edge, or none (got "banana")',
  );
});

Deno.test("exportBook: rejects an unrecognized flip value", async () => {
  const out = await Deno.makeTempDir();
  await assertRejects(
    () =>
      exportBook(ROOT, "demo-book", {
        proof: true,
        // deno-lint-ignore no-explicit-any
        flip: "banana" as any,
        sheet: "legal",
        out,
      }),
    Error,
    'flip must be short-edge or long-edge (got "banana")',
  );
});

Deno.test("exportBook: rejects a nonexistent book before writing anything", async () => {
  const out = await Deno.makeTempDir();
  await assertRejects(
    () => exportBook(ROOT, "no-such-book", { proof: true, out }),
    Error,
    "no such book: no-such-book",
  );
  const entries = [];
  for await (const e of Deno.readDir(out)) entries.push(e.name);
  assertEquals(entries, []); // exportBook must not have written into `out` either
});

Deno.test("exportBook: falls back to metadata.json's print section when no flags are given", async () => {
  const root = await Deno.makeTempDir();
  const bookDir = `${root}/book`;
  await Deno.mkdir(bookDir, { recursive: true });
  await Deno.writeTextFile(`${bookDir}/manuscript.md`, "{title}\nBook\n");
  await Deno.writeTextFile(
    `${bookDir}/metadata.json`,
    JSON.stringify({
      print: {
        "sheet-size": "legal",
        "folios-per-signature": 2,
        duplex: "long-edge",
      },
    }),
  );
  const s = await exportBook(root, "book", { proof: true });
  assertEquals(s.resolved, { sheet: "legal", duplex: "long-edge", folios: 2 });
});

// Reads the /BBox height of each embedded-page XObject on `page`, in the order pdf-lib
// listed them in the page's /Resources /XObject dict — which is the order buildSheetPdf's
// drawSlot calls drew them in, since PDFDict preserves insertion order. Each source page in
// the test below has a distinct height (100 + i), so the BBox height identifies which source
// page landed in which slot without having to parse the content stream's `Do` operators.
function xobjectHeightsInOrder(page: PDFPage): number[] {
  const resources = page.node.Resources();
  if (!resources) return [];
  const xobjects = resources.lookup(PDFName.of("XObject"), PDFDict);
  return xobjects.keys().map((name) => {
    const form = xobjects.lookup(name, PDFStream);
    const bbox = form.dict.lookup(PDFName.of("BBox"));
    // deno-lint-ignore no-explicit-any
    const height = (bbox as any).asArray()[3].asNumber();
    return height as number;
  });
}

Deno.test("buildSheetPdf: draws embedded pages in slot order (spec §7.7 4-up example)", async () => {
  // Source: 8 pages, each with a distinct height (100 + i) so we can tell them apart by BBox.
  const src = await PDFDocument.create();
  for (let i = 0; i < 8; i++) {
    src.addPage([50, 100 + i]).drawText(String(i + 1), { x: 5, y: 5, size: 8 });
  }
  const bytes = await buildSheetPdf(
    sidesFor(imp, "duplex", false),
    geom,
    await src.save(),
  );
  const doc = await PDFDocument.load(bytes);
  const toPageNumbers = (heights: number[]) => heights.map((h) => h - 100 + 1); // 1-based source page
  assertEquals(toPageNumbers(xobjectHeightsInOrder(doc.getPage(0))), [
    8,
    1,
    6,
    3,
  ]); // front
  assertEquals(toPageNumbers(xobjectHeightsInOrder(doc.getPage(1))), [
    4,
    5,
    2,
    7,
  ]); // back
});

Deno.test("exportBook: trim size comes from book.pdf, not metadata.page.size", async () => {
  const root = await Deno.makeTempDir();
  const bookDir = `${root}/book`;
  await Deno.mkdir(`${bookDir}/images`, { recursive: true });
  await Deno.writeTextFile(`${bookDir}/manuscript.md`, "{title}\nBook\n");
  await Deno.writeTextFile(`${bookDir}/metadata.json`, JSON.stringify({})); // no page.size at all
  const out = await Deno.makeTempDir();

  // Stub renderer: no Chrome — 4 Letter-size (8.5×11in) pages instead of the demo's 5.5×8.5in.
  const render = async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) {
      doc.addPage([612, 792]).drawText(String(i + 1), {
        x: 20,
        y: 20,
        size: 12,
      }); // 8.5×11in in points
    }
    return await doc.save();
  };

  const s = await exportBook(root, "book", {
    proof: false,
    sheet: "tabloid",
    duplex: "short-edge",
    out,
    render,
  });
  assertEquals(s.pageCount, 4);
  assertEquals(s.imposition.nUp, 2); // 8.5×11in pages, 2-up on tabloid (only fits at Letter size, not the 5.5×8.5in default)
  await Deno.stat(`${out}/book.pdf`);
});

Deno.test("formatSummary is one line plus a waste warning when relevant", () => {
  const imp = impose(12, {
    folios: 3,
    sheet: parseDims("legal"),
    page: { w: 3.5, h: 8.5 },
    duplex: "short-edge",
    flip: "short-edge",
  });
  const text = formatSummary("demo", {
    pageCount: 12,
    imposition: imp,
    files: [],
    diagnostics: 0,
    resolved: { sheet: "legal", duplex: "short-edge", folios: 3 },
  }, { sheet: "legal", duplex: "short-edge" });
  assertEquals(
    text.split("\n")[0],
    "demo: 12 pages → 12 padded · 1 signature × 3 folios · 4-up on legal · 2 sheets · duplex short-edge",
  );
  assertEquals(
    text.split("\n")[1],
    "warning: 1 blank folio slot per signature (cut half is waste)",
  );
});
