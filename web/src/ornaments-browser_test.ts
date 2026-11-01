// web/src/ornaments-browser_test.ts — a binder with no art of their own gets
// page ornaments from the panel alone, and the art lands on the page turned.
import { assert, assertEquals } from "@std/assert";
import { appTest, book, openApp } from "../../testing/app.ts";
import { eventually, laidOut } from "../../testing/wait.ts";

const LIVE = "#preview > :not(.preview-stage) .pagedjs_page";
const OPENER = `${LIVE}:has(.page-ornament)`;

appTest({
  name: "ornaments: a starter in the panel sets a page's corners",
  async fn() {
    const b = await book({
      metadata: (m) => {
        m.numbering = { pages: { position: "top-outside" } };
      },
    });
    const page = await openApp(b, "&mode=style&view=chapter");
    await page.locator('.sec[data-focus="ornaments"] .tog:has-text("Add")')
      .click();
    await page.locator('.orn-shape:has-text("Corners")').click();
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
    await page.getByText("an ornament runs into the head or page number")
      .first().waitFor();

    const laidSegments = () =>
      page.locator("#preview").evaluate((el) =>
        (el as HTMLElement).dataset.segmentsLaid
      );
    const before = await laidSegments();
    await page.locator('.orn-spot[aria-label="bottom right"]').click();
    await eventually(async () =>
      assertEquals(
        JSON.parse((await b.read("metadata.json"))!).ornaments.chapter[0]
          .at
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

    assertEquals(await laidSegments(), before);

    await page.locator('[data-mode="write"], button:has-text("Write")').first()
      .click();
    await page.locator(`${OPENER} .page-ornament`).first().click();
    await page.locator(".orn-page").waitFor();

    // A border on every page of the chapter, where corners stay on the first.
    await page.locator('.sec[data-focus="ornaments"] .tog:has-text("Add")')
      .click();
    await page.locator('.orn-shape:has-text("Border")').click();
    await page.locator('.orn-tile[title="Double"]').click();
    await page.locator(`${LIVE} .page-ornament-rule`).first().waitFor();
    await eventually(async () =>
      assertEquals(
        JSON.parse((await b.read("metadata.json"))!).ornaments.chapter[1].style,
        "double",
      )
    );
  },
});
