// web/src/ornaments-browser_test.ts — a binder with no art of their own gets
// corner ornaments from the panel alone, and the art lands on the page turned.
import { assert, assertEquals } from "@std/assert";
import { appTest, book, openApp } from "../../testing/app.ts";
import { eventually, laidOut } from "../../testing/wait.ts";

const LIVE = "#preview > :not(.preview-stage) .pagedjs_page";
const OPENER = `${LIVE}:has(.page-ornament)`;

appTest({
  name: "ornaments: a starter in the panel sets a page's corners",
  async fn() {
    const b = await book();
    const page = await openApp(b, "&mode=style&view=chapter");
    await page.locator('.orn-tile[title="Vine"]').click();
    await page.locator(`${OPENER} .page-ornament`).first().waitFor();
    assert(await b.read("images/corner-vine.svg"));

    const first = page.locator(OPENER)
      .first();
    assertEquals(await first.locator(".page-ornament").count(), 4);
    const pageBox = (await first.boundingBox())!;
    const bottomRight = (await first.locator(".page-ornament").nth(2)
      .boundingBox())!;
    assert(bottomRight.x > pageBox.x + pageBox.width / 2);
    assert(bottomRight.y > pageBox.y + pageBox.height / 2);
    assertEquals(
      await first.locator(".page-ornament img").nth(2).evaluate((i) =>
        (i as HTMLElement).style.transform
      ),
      "rotate(180deg)",
    );

    await page.locator('.orn-corner[aria-label="bottom right"]').click();
    await eventually(async () =>
      assertEquals(
        JSON.parse((await b.read("metadata.json"))!).ornaments.chapter[0]
          .corners
          .length,
        3,
      )
    );
    await laidOut(page);
    await eventually(async () =>
      assertEquals(
        await page.locator(OPENER).first()
          .locator(".page-ornament").count(),
        3,
      )
    );

    await page.locator('[data-mode="write"], button:has-text("Write")').first()
      .click();
    await page.locator(`${OPENER} .page-ornament`).first().click();
    await page.locator(".orn-page").waitFor();
  },
});
