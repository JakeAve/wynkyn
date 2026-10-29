// web/src/preview-zoom-browser_test.ts — zoom in the real app: 200% doubles
// the live pages, a spread still sits side by side past the pane's width, the
// zoom survives a reload, and Fit spread brings it back to 100%.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { Page } from "playwright";
import { appTest, book, openApp } from "../../testing/app.ts";
import { laidOut } from "../../testing/wait.ts";

const LIVE = "#preview > :not(.preview-stage) .pagedjs_page";
const rect = (page: Page, i: number) =>
  page.locator(LIVE).nth(i).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, top: r.top };
  });

appTest({
  name: "preview zoom: 200% doubles the pages, keeps spreads, persists",
  async fn() {
    const page = await openApp(await book());
    const zoom = page.locator('#zoom [data-zoom="menu"]');
    assertEquals(await zoom.innerText(), "100%");
    const at100 = await rect(page, 1);

    for (let i = 0; i < 10; i++) {
      await page.getByRole("button", { name: "Zoom in" }).click();
    }
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
    await laidOut(page);
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
  },
});
