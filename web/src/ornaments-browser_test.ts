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
    // Whichever starter comes first: the art will change, the flow won't.
    await page.locator(".orn-tile").first().click();
    await page.locator(`${OPENER} .page-ornament`).first().waitFor();
    const image = await eventually(async () =>
      JSON.parse((await b.read("metadata.json"))!).ornaments.chapter[0].image
    );
    assert(await b.read(`images/${image}.svg`));

    const first = page.locator(OPENER).first();
    assertEquals(await first.locator(".page-ornament").count(), 4);
    const pageBox = (await first.boundingBox())!;
    const bottomRight = (await first.locator(".page-ornament").nth(2)
      .boundingBox())!;
    assert(bottomRight.x > pageBox.x + pageBox.width / 2);
    assert(bottomRight.y > pageBox.y + pageBox.height / 2);
    // A starter is SVG, so no dpi warning: the one warning is the collision.
    await eventually(async () =>
      assert(
        await first.evaluate((p) =>
          (globalThis as unknown as {
            BookPageMap: {
              pageProblems(p: Element, n: number): { warn?: true }[];
            };
          }).BookPageMap.pageProblems(p, 1).some((x) => x.warn)
        ),
      )
    );

    const laidSegments = () =>
      page.locator("#preview").evaluate((el) =>
        (el as HTMLElement).dataset.segmentsLaid
      );
    const before = await laidSegments();
    const layouts = await laidOut(page);
    await page.locator('.orn-spot[aria-label="bottom right"]').click();
    await eventually(async () =>
      assertEquals(
        JSON.parse((await b.read("metadata.json"))!).ornaments.chapter[0]
          .at
          .length,
        3,
      )
    );
    await laidOut(page, layouts);
    await eventually(async () =>
      assertEquals(
        await page.locator(OPENER).first()
          .locator(".page-ornament").count(),
        3,
      )
    );

    assertEquals(await laidSegments(), before);

    await page.locator('#modes [data-mode="write"]').click();
    await page.locator(`${OPENER} .page-ornament`).first().click();
    await page.locator(".orn-page").waitFor();

    // A border on every page of the chapter, where corners stay on the first.
    await page.locator('.sec[data-focus="ornaments"] .tog:has-text("Add")')
      .click();
    await page.locator('.orn-shape:has-text("Border")').click();
    await page.locator(".orn-tile:has(.orn-rule-double)").click();
    await page.locator(`${LIVE} .page-ornament-rule`).first().waitFor();
    // Saved, or the reload would drop it.
    await eventually(async () =>
      assertEquals(
        JSON.parse((await b.read("metadata.json"))!).ornaments.chapter[1].style,
        "double",
      )
    );

    // The cached pages hold no ornaments: a reload sets them, art included.
    await page.reload();
    await eventually(async () =>
      assert(
        await page.locator(`${OPENER} .page-ornament-spot img`).first()
          .evaluate((i) => (i as HTMLImageElement).naturalWidth > 0),
      )
    );
  },
});
