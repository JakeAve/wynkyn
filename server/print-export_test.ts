import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { PDFDict, PDFDocument, PDFName, PDFPage, PDFStream } from "pdf-lib";
import { impose, parseDims } from "./imposition.ts";
import { resolvePageSetup } from "../metadata/page-setup.ts";
import {
  buildSheetPdf,
  exportBook,
  formatSummary,
  sidesFor,
} from "./print-export.ts";
import { renderPdf } from "./pdf.ts";
import type { PageProblem } from "../renderer/page-map-types.ts";
import { hasChrome } from "../testing/chrome.ts";

const page = { w: 3.5, h: 8.5 };
const imp = impose(8, {
  folios: 2,
  sheet: parseDims("legal"),
  page,
  duplex: "short-edge",
  flip: "short-edge",
});
// Derived from the imposition, exactly as exportBook does it, so the sheet
// orientation and grid can never drift from what the slots were laid out for.
const geom = {
  sheet: imp.sheet,
  page,
};

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

Deno.test("exportBook: upgrades a legacy print section when no flags are given", async () => {
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
  // A legacy `print` section is folded into `page` on load (metadata/upgrade.ts).
  assertEquals(
    [s.setup.sheet, s.setup.duplex, s.setup.folios],
    ["legal", "long-edge", 2],
  );
});

Deno.test("exportBook --proof: binding marks add drawing to the sheets", async () => {
  // Total bytes of every content stream on the first sheet page.
  const contentSize = async (marks: boolean) => {
    const root = await Deno.makeTempDir();
    const bookDir = `${root}/book`;
    await Deno.mkdir(bookDir, { recursive: true });
    await Deno.writeTextFile(`${bookDir}/manuscript.md`, "{title}\nBook\n");
    await Deno.writeTextFile(
      `${bookDir}/metadata.json`,
      JSON.stringify({
        page: {
          size: "3.5in 8.5in",
          sheet: "legal",
          "folios-per-signature": 2,
          ...(marks ? { marks: { show: true } } : {}),
        },
      }),
    );
    const s = await exportBook(root, "book", { proof: true });
    const doc = await PDFDocument.load(await Deno.readFile(s.files[0]!));
    const contents = doc.getPage(0).node.Contents();
    const streams = contents instanceof PDFStream
      ? [contents]
      : contents?.asArray().map((r) => doc.context.lookup(r, PDFStream)) ?? [];
    return streams.reduce((n, c) => n + c.getContents().length, 0);
  };
  assertEquals(await contentSize(true) > await contentSize(false), true);
});

Deno.test("export reads the page setup from the page section", async () => {
  const root = await Deno.makeTempDir();
  const bookDir = `${root}/book`;
  await Deno.mkdir(bookDir, { recursive: true });
  await Deno.writeTextFile(`${bookDir}/manuscript.md`, "{title}\nBook\n");
  await Deno.writeTextFile(
    `${bookDir}/metadata.json`,
    JSON.stringify({
      page: {
        size: "3.5in 8.5in",
        sheet: "legal",
        "folios-per-signature": 2,
        duplex: "long-edge",
      },
    }),
  );
  const s = await exportBook(root, "book", { proof: true });
  assertEquals(
    [s.setup.sheet, s.setup.duplex, s.setup.folios, s.setup.nUp],
    ["legal", "long-edge", 2, 4],
  );
});

Deno.test("export rejects a page that cannot be printed on the sheet", async () => {
  const root = await Deno.makeTempDir();
  const bookDir = `${root}/book`;
  await Deno.mkdir(bookDir, { recursive: true });
  await Deno.writeTextFile(`${bookDir}/manuscript.md`, "{title}\nBook\n");
  await Deno.writeTextFile(
    `${bookDir}/metadata.json`,
    JSON.stringify({ page: { size: "6in 9in", sheet: "letter" } }),
  );
  await assertRejects(
    () => exportBook(root, "book", { proof: true }),
    Error,
    "does not fit two-up",
  );
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
    return { pdf: await doc.save(), problems: [], passes: 1, seed: {} };
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

Deno.test("exportBook: pagination problems fail the export unless force", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/book`);
  await Deno.writeTextFile(`${root}/book/manuscript.md`, "{title}\nBook\n");
  const out = await Deno.makeTempDir();
  const render = async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([396, 612]).drawText(String(i + 1));
    return {
      pdf: await doc.save(),
      problems: [{ page: 3, message: "stranded page: no text or image" }],
      passes: 2,
      seed: {},
    };
  };
  const opts = { sheet: "legal", duplex: "short-edge" as const, out, render };
  const err = await assertRejects(() => exportBook(root, "book", opts));
  assertStringIncludes(
    (err as Error).message,
    "page 3: stranded page: no text or image",
  );
  await assertRejects(() => Deno.stat(`${out}/book.pdf`), Deno.errors.NotFound);
  const s = await exportBook(root, "book", { ...opts, force: true });
  assertEquals(s.pagination.length, 1);
  await Deno.stat(`${out}/book.pdf`);
});

Deno.test("exportBook: a warning is listed but never fails the export", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/book`);
  await Deno.writeTextFile(`${root}/book/manuscript.md`, "{title}\nBook\n");
  const out = await Deno.makeTempDir();
  const warning: PageProblem = {
    page: 2,
    warn: true,
    message: "top-center margin box runs to 2 lines",
  };
  const render = async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([396, 612]).drawText(String(i + 1));
    return { pdf: await doc.save(), problems: [warning], passes: 1, seed: {} };
  };
  const s = await exportBook(root, "book", {
    sheet: "legal",
    duplex: "short-edge",
    out,
    render,
  });
  assertEquals(s.pagination, [warning]);
  await Deno.stat(`${out}/book.pdf`);
  await Deno.stat(`${out}/page-map.json`); // a warned render's seed still settles
});

Deno.test("exportBook: reuses page-map.json only for the identical input, and only a clean render's", async () => {
  const root = await Deno.makeTempDir();
  for (const book of ["book", "other"]) {
    await Deno.mkdir(`${root}/${book}`);
    await Deno.writeTextFile(
      `${root}/${book}/manuscript.md`,
      `{title}\n${book}\n`,
    );
  }
  const out = await Deno.makeTempDir();
  const map = `${out}/page-map.json`;
  const seedIn: string[] = []; // the BOOK_SEED each render started from
  let problems: PageProblem[] = [];
  const render = async (html: string) => {
    seedIn.push(html.match(/const BOOK_SEED = (.*);/)![1]!);
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([396, 612]).drawText(String(i + 1));
    return { pdf: await doc.save(), problems, passes: 1, seed: { a: "7" } };
  };
  const opts = { sheet: "legal", duplex: "short-edge" as const, out, render };
  const s = await exportBook(root, "book", opts);
  assertEquals(s.files.includes(map), true);
  await exportBook(root, "book", opts); // unchanged -> seeded
  await Deno.writeTextFile(
    `${root}/book/metadata.json`,
    JSON.stringify({ elements: { body: { "font-size": "12pt" } } }),
  );
  await exportBook(root, "book", opts); // changed metadata -> clean
  await exportBook(root, "other", opts); // another book in a shared --out
  await Deno.writeTextFile(map, "{ not json");
  await exportBook(root, "other", opts);
  assertEquals(seedIn, ["{}", '{"a":"7"}', "{}", "{}", "{}"]);
  assertEquals(Object.keys(JSON.parse(await Deno.readTextFile(map))), [
    "inputHash",
    "seed",
  ]);
  // --force with problems (e.g. no fixed point) saves no seed.
  await Deno.remove(map);
  problems = [{ page: null, message: "no fixed point after 3 passes" }];
  const forced = await exportBook(root, "book", { ...opts, force: true });
  assertEquals(forced.files.includes(map), false);
  await assertRejects(() => Deno.stat(map), Deno.errors.NotFound);
});

Deno.test({
  name: "exportBook: an unchanged book re-exports in one pass (real Chrome)",
  ignore: !hasChrome,
  fn: async () => {
    const root = await Deno.makeTempDir();
    await Deno.mkdir(`${root}/book`);
    // A TOC: pass 1 from {} prints 000, so a fresh export takes 2 passes.
    await Deno.writeTextFile(
      `${root}/book/manuscript.md`,
      "{matter: toc}\n{title}\nContents\n\n{chapter: one}\n{title}\nOne\n\nText.\n\n{chapter: two}\n{title}\nTwo\n\nMore.\n",
    );
    const out = await Deno.makeTempDir();
    const passes: number[] = [];
    const render = async (html: string) => {
      const r = await renderPdf(html);
      passes.push(r.passes);
      return r;
    };
    // No metadata → Letter pages, 2-up on tabloid.
    const opts = {
      sheet: "tabloid",
      duplex: "short-edge" as const,
      out,
      render,
    };
    await exportBook(root, "book", opts);
    await exportBook(root, "book", opts);
    // Any change to the layout inputs starts clean, so takes 2 again.
    await Deno.writeTextFile(
      `${root}/book/metadata.json`,
      JSON.stringify({ elements: { body: { "font-size": "12pt" } } }),
    );
    await exportBook(root, "book", opts);
    assertEquals(passes, [2, 1, 2]);
    await Deno.stat(`${out}/page-map.json`);
  },
});

Deno.test("formatSummary is one line plus waste and font warnings when relevant", () => {
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
    pagination: [],
    missingFonts: ["No Such Face"],
    setup: resolvePageSetup({
      size: "3.5in 8.5in",
      sheet: "legal",
      "folios-per-signature": 3,
    }),
  });
  assertEquals(
    text.split("\n")[0],
    "demo: 12 pages → 12 padded · 1 signature × 3 folios · cut, 4-up on legal · 2 sheets · duplex short-edge",
  );
  assertEquals(
    text.split("\n")[1],
    "warning: 1 blank folio slot per signature (cut half is waste)",
  );
  assertEquals(
    text.split("\n")[2],
    'warning: font "No Such Face" is not a Google font and is not installed here, so the PDF uses a fallback',
  );
});

Deno.test("exportBook --edition: uses that edition's page size and writes under export/<edition>/", async () => {
  // Copy the fixture so the default out dir lands in a temp tree, not testdata/.
  const root = await Deno.makeTempDir();
  const src = new URL("./testdata/demo-book/", import.meta.url);
  await Deno.mkdir(`${root}/demo-book/editions`, { recursive: true });
  for (const f of ["manuscript.md", "metadata.json", "editions/pocket.json"]) {
    await Deno.copyFile(new URL(f, src), `${root}/demo-book/${f}`);
  }
  try {
    // pocket is 3.5×5in → a quarto of legal (8.5×14): 2 folios = 1 sheet = 2 sides.
    const s = await exportBook(root, "demo-book", {
      proof: true,
      folios: 2,
      sheet: "legal",
      duplex: "short-edge",
      edition: "pocket",
    });
    assertEquals(s.imposition.nUp, 4);
    assertEquals(s.files, [`${root}/demo-book/export/pocket/sheets.pdf`]);

    const base = await exportBook(root, "demo-book", {
      proof: true,
      folios: 2,
      sheet: "legal",
      duplex: "short-edge",
    });
    assertEquals(base.files, [`${root}/demo-book/export/sheets.pdf`]);

    await assertRejects(
      () => exportBook(root, "demo-book", { proof: true, edition: "nope" }),
      Error,
      "no such edition: demo-book/nope",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildSheetPdf: a quartered setup prints a portrait sheet, 2 × 2", async () => {
  const qpage = { w: 4.25, h: 7 }; // legal halved on both sides
  const q = impose(16, {
    folios: 4,
    sheet: parseDims("legal"),
    page: qpage,
    duplex: "long-edge",
    flip: "short-edge",
  });
  const bytes = await buildSheetPdf(sidesFor(q, "duplex", false), {
    sheet: q.sheet,
    page: qpage,
  }, null);
  const doc = await PDFDocument.load(bytes);
  // Portrait, at the sheet's real dimensions — not the landscape 2-up shape.
  assertEquals(doc.getPage(0).getSize(), { width: 8.5 * 72, height: 14 * 72 });
  // Four sides for two sheets, and the grid tiles the sheet with nothing over.
  assertEquals(doc.getPageCount(), 4);
  assertEquals([q.cols * qpage.w, q.rows * qpage.h], [8.5, 14]);
});

Deno.test("exportBook: a booklet is one signature sized by the rendered pages; flip and reverse-backs come from the page section", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/book`);
  await Deno.writeTextFile(`${root}/book/manuscript.md`, "{title}\nBook\n");
  await Deno.writeTextFile(
    `${root}/book/metadata.json`,
    JSON.stringify({
      page: {
        sheet: "legal",
        "folios-per-signature": "booklet",
        duplex: "none",
        "reverse-backs": true,
      },
    }),
  );
  const out = await Deno.makeTempDir();
  const render = async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 10; i++) {
      doc.addPage([396, 612]).drawText(String(i + 1));
    }
    return { pdf: await doc.save(), problems: [], passes: 1, seed: {} };
  };
  const s = await exportBook(root, "book", { out, render });
  assertEquals(s.setup.folios, 3); // 10 pages → 12 → 3 folios
  assertEquals(s.imposition.signatures, 1);
  assertEquals(s.imposition.sheets.length, 3);
  // reverse-backs: the backs file starts at the last sheet.
  const backs = sidesFor(s.imposition, "backs", true).map((x) => x.label);
  assertEquals(backs[0], "sig 1 · sheet 3 · back");
  await assertRejects(
    () => exportBook(root, "book", { out, proof: true }),
    Error,
    "a booklet proof needs --pages",
  );
});
