// web/src/print-browser_test.ts — the Publish tab's print buttons in the real
// app: Print sheets imposes the preview's pages onto sheet-sized print pages,
// so printing to PDF gives one sheet side per page at the sheet size, the
// layout sheets.pdf has; Print pages gives the pages as they are, book.pdf's.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { startServer } from "../../server/dev-server.ts";
import { impose } from "../../server/imposition.ts";
import { resolvePageSetup } from "../../metadata/page-setup.ts";
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
