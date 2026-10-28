// web/src/print-browser_test.ts — the Publish tab's print buttons in the real
// app: Print sheets imposes the preview's pages onto sheet-sized print pages,
// so printing to PDF gives one sheet side per page at the sheet size, the
// layout sheets.pdf has; Print pages gives the pages as they are, book.pdf's.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { startServer } from "../../server/dev-server.ts";
import { impose, sidesFor } from "../../server/imposition.ts";
import { marksFor } from "../../server/marks.ts";
import { resolveMarks, resolvePageSetup } from "../../metadata/page-setup.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

Deno.test({
  name:
    "browser print: sheet sides at the sheet size, then pages at the page size",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = new URL("../../server/testdata", import.meta.url).pathname;
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await page.locator('#status[data-kind="saved"]').waitFor();
      // Paginated and settled: pages on screen, no render staged behind them.
      await page.waitForFunction(() =>
        document.querySelector("#preview .pagedjs_page") &&
        !document.querySelector("#preview .preview-stage")
      );
      const n = await page.locator(
        "#preview > :not(.preview-stage) .pagedjs_page",
      ).count();
      // The dialog never opens headless; the layer stays for page.pdf().
      await page.evaluate(() => {
        globalThis.print = () =>
          document.documentElement.setAttribute("data-printed", "");
      });
      await page.locator('#modes [data-mode="publish"]').click();
      await page.getByRole("button", { name: "Print sheets" }).click();
      await page.locator("html[data-printed]").waitFor();

      const meta = JSON.parse(
        await Deno.readTextFile(`${root}/demo-book/metadata.json`),
      );
      const setup = resolvePageSetup(meta.page, { pageCount: n });
      if (setup.error !== null) throw new Error(setup.error);
      const imp = impose(n, {
        folios: setup.folios,
        fold: setup.fold,
        sheet: setup.sheetDims,
        page: setup.page,
        duplex: setup.duplex,
        flip: "short-edge",
      });
      const slots = imp.sheets.flatMap((s) => [...s.front, ...s.back]);
      assertEquals(
        await page.locator("#print-sheets .pagedjs_page").count(),
        slots.filter((t) => t.page !== null).length,
      );
      // The clones sit in their render's scope, so the book's CSS reaches them.
      const face = await page.locator("#print-sheets .pagedjs_page p").first()
        .evaluate((p) => getComputedStyle(p).fontFamily);
      assert(face.includes("EB Garamond"), `printed in ${face}`);
      const pdf = await PDFDocument.load(
        await page.pdf({ preferCSSPageSize: true, printBackground: true }),
      );
      assertEquals(pdf.getPageCount(), imp.sheets.length * 2);
      const { width, height } = pdf.getPage(0).getSize();
      assertAlmostEquals(width / 72, imp.sheet.w, 0.01);
      assertAlmostEquals(height / 72, imp.sheet.h, 0.01);

      // Print pages: every page in reading order at the page size. A picked
      // and a highlighted element in the preview print without their marks.
      await page.evaluate(() => {
        document.documentElement.removeAttribute("data-printed");
        const els = document.querySelectorAll(
          "#preview > :not(.preview-stage) .pagedjs_page .bml p",
        );
        els[0]?.setAttribute("data-style-selected", "");
        els[1]?.setAttribute("data-style-hl", "");
      });
      await page.getByRole("button", { name: "Print pages" }).click();
      await page.locator("html[data-printed]").waitFor();
      await page.emulateMedia({ media: "print" });
      const marks = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "#print-sheets [data-style-selected], #print-sheets [data-style-hl]",
          ),
        ].map((el) => {
          const s = getComputedStyle(el);
          return `${s.outlineStyle} ${s.backgroundColor}`;
        })
      );
      assertEquals(marks, ["none rgba(0, 0, 0, 0)", "none rgba(0, 0, 0, 0)"]);
      const pages = await PDFDocument.load(
        await page.pdf({ preferCSSPageSize: true, printBackground: true }),
      );
      assertEquals(pages.getPageCount(), n);
      const at = pages.getPage(0).getSize();
      assertAlmostEquals(at.width / 72, setup.page.w, 0.01);
      assertAlmostEquals(at.height / 72, setup.page.h, 0.01);
    } finally {
      await browser.close();
      await server.stop();
    }
  },
});

Deno.test({
  name: "browser print: binding marks draw as many marks as marksFor",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    // Switching marks on saves metadata.json: work on a copy of the fixture.
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const metaPath = `${root}/demo-book/metadata.json`;
    const saved = async () =>
      JSON.parse(await Deno.readTextFile(metaPath)).page.marks;
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await page.locator('#status[data-kind="saved"]').waitFor();
      await page.waitForFunction(() =>
        document.querySelector("#preview .pagedjs_page") &&
        !document.querySelector("#preview .preview-stage")
      );
      const n = await page.locator(
        "#preview > :not(.preview-stage) .pagedjs_page",
      ).count();
      await page.evaluate(() => {
        globalThis.print = () =>
          document.documentElement.setAttribute("data-printed", "");
      });
      await page.locator('#modes [data-mode="publish"]').click();
      const sewing = page.getByRole("switch", { name: "Sewing stations" });
      assert(await sewing.isHidden(), "sub-marks hide while marks are off");
      await page.getByRole("switch", { name: "Binding marks" }).check();
      assert(await sewing.isVisible(), "sub-marks show once marks are on");
      // Saves are debounced in the page, so wait for the file to catch up.
      for (let i = 0; i < 50 && !(await saved())?.show; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assertEquals(await saved(), { show: true });
      await page.getByRole("button", { name: "Print sheets" }).click();
      await page.locator("html[data-printed]").waitFor();

      const meta = JSON.parse(await Deno.readTextFile(metaPath));
      const setup = resolvePageSetup(meta.page, { pageCount: n });
      if (setup.error !== null) throw new Error(setup.error);
      const imp = impose(n, {
        folios: setup.folios,
        fold: setup.fold,
        sheet: setup.sheetDims,
        page: setup.page,
        duplex: setup.duplex,
        flip: "short-edge",
      });
      const want = sidesFor(
        imp,
        "duplex",
        false,
        marksFor(imp, setup.page, resolveMarks(meta.page.marks)),
      ).map((s) => [s.marks.dots.length, s.marks.lines.length]);
      const got = await page.evaluate(() =>
        [...document.querySelectorAll("#print-sheets .print-sheet")].map(
          (sheet) => [
            sheet.querySelectorAll(".print-marks circle").length,
            sheet.querySelectorAll(".print-marks line").length,
          ],
        )
      );
      assertEquals(got, want);
      assert(want.flat().some((k) => k > 0), "some side carries marks");
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
