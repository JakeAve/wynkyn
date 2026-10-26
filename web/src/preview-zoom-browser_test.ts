// web/src/preview-zoom-browser_test.ts — zoom in the real app: 200% doubles
// the live pages, a spread still sits side by side past the pane's width, the
// zoom survives a reload, and Fit spread brings it back to 100%.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

const LIVE = "#preview > :not(.preview-stage) .pagedjs_page";
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.querySelector("#preview .pagedjs_page") &&
    !document.querySelector("#preview .preview-stage")
  );
const rect = (page: Page, i: number) =>
  page.locator(LIVE).nth(i).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, top: r.top };
  });

Deno.test({
  name: "preview zoom: 200% doubles the pages, keeps spreads, persists",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = new URL("../../server/testdata", import.meta.url).pathname;
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await settled(page);
      const zoom = page.locator('#zoom [data-zoom="menu"]');
      assertEquals(await zoom.innerText(), "100%");
      const at100 = await rect(page, 1);

      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.getByRole("button", { name: "Zoom in" }).click();
      assertEquals(await zoom.innerText(), "200%");
      const at200 = await rect(page, 1);
      assertAlmostEquals(at200.width, 2 * at100.width, 1);
      // Pages 2 and 3 are a spread: still one row, though wider than the pane.
      assertEquals((await rect(page, 2)).top, at200.top);
      assert(
        await page.locator("#preview").evaluate((el) =>
          el.scrollWidth > el.clientWidth
        ),
        "scrolls sideways",
      );

      await page.reload();
      await settled(page);
      assertEquals(await zoom.innerText(), "200%");
      assertEquals(
        await page.evaluate(() => localStorage.getItem("preview-zoom")),
        "2",
      );
      assertAlmostEquals((await rect(page, 1)).width, at200.width, 1);

      await zoom.click();
      await page.getByRole("menuitemradio", { name: /Fit spread/ }).click();
      assertEquals(await zoom.innerText(), "100%");
      assertAlmostEquals((await rect(page, 1)).width, at100.width, 1);
    } finally {
      await browser.close();
      await server.stop();
    }
  },
});
