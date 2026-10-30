// web/src/history-browser_test.ts — History in the real app: name a version
// from the toolbar's menu, preview it on the pages, Esc back to now, then
// restore its styles only and undo that from the pages' banner.
import { assert, assertEquals } from "@std/assert";
import type { Page } from "playwright";
import { appTest, book, openApp } from "../../testing/app.ts";
import { laidOut, until } from "../../testing/wait.ts";

// The first live page's width over its height.
const ratio = (page: Page) =>
  page.locator("#preview > :not(.preview-stage) .pagedjs_page").first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.width / r.height * 100) / 100;
    });

appTest({
  name: "history: preview a styles version, Esc, restore its styles, undo",
  async fn() {
    const b = await book({ metadata: (m) => m.page!.size = "4in 8in" });
    const size = async () =>
      JSON.parse((await b.read("metadata.json"))!).page.size as string;
    const manuscript = await b.read("manuscript.md");
    const page = await openApp(b);
    const menuButton = page.getByRole("button", {
      name: "History",
      exact: true,
    });
    const banner = page.locator("#version-banner");
    const historyParam = () => new URL(page.url()).searchParams.get("history");

    await menuButton.click();
    await page.getByRole("button", { name: "Name this version…" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Tall");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.locator("#name-dlg").waitFor({ state: "hidden" });

    // The book now is square.
    let n = await laidOut(page);
    const meta = JSON.parse((await b.read("metadata.json"))!);
    meta.page.size = "6in 6in";
    await b.write("metadata.json", JSON.stringify(meta));
    n = await laidOut(page, n);
    assertEquals(await ratio(page), 1);

    const pickTall = async () => {
      await menuButton.click();
      const tall = page.locator("#history-list .h-row", { hasText: "Tall" });
      const id = await tall.getAttribute("data-id");
      await tall.click();
      await until(() => historyParam() === id, "the version in the URL");
      n = await laidOut(page, n);
    };
    await pickTall();
    assertEquals(await ratio(page), 0.5);
    assert((await banner.innerText()).startsWith("Previewing Tall"));
    assertEquals(await size(), "6in 6in", "previewing writes nothing");
    assert(await page.locator("#undo").isDisabled());
    assert(await page.locator("#editor").isVisible(), "Write stays");

    await page.keyboard.press("Escape");
    await until(() => historyParam() === null, "back to now");
    n = await laidOut(page, n);
    assertEquals(await ratio(page), 1);

    await pickTall();
    await banner.getByRole("button", { name: "Restore ▾" }).click();
    await page.getByRole("menuitem", { name: /^Styles only/ }).click();
    await until(async () => await size() === "4in 8in", "the styles restored");
    assertEquals(await b.read("manuscript.md"), manuscript);
    await until(() => historyParam() === null, "the preview ended");

    await banner.getByRole("button", { name: "Undo" }).click();
    await until(async () => await size() === "6in 6in", "the restore undone");
    await until(async () => await ratio(page) === 1, "the live pages again");
  },
});
