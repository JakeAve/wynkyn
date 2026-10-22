// web/src/print-browser_test.ts — the Publish tab's Print button in the real
// app: the print layer imposes the preview's pages onto sheet-sized print
// pages, so printing to PDF gives one sheet side per page at the sheet size,
// the layout sheets.pdf has.
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
  name: "browser print: one sheet side per printed page, at the sheet size",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = new URL("../../server/testdata", import.meta.url).pathname;
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/?book=demo-book`);
      await page.locator('#status[data-kind="saved"]').waitFor();
      // Paginated and settled: pages on screen, no render staged behind them.
      await page.waitForFunction(() =>
        document.querySelector("#preview .pagedjs_page") &&
        !document.querySelector("#preview .preview-stage")
      );
      const n = await page.locator("#preview .pagedjs_page").count();
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
    } finally {
      await browser.close();
      await server.stop();
    }
  },
});
