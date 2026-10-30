// web/src/history-browser_test.ts — History in the real app: name a version
// from the toolbar's menu; pick it and what it changed replaces the editor
// side while its pages show; Back to editing returns to the same place;
// restore its styles (this edition's file only) and undo that from the banner.
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
  name: "history: pick a styles version, back to editing, restore, undo",
  async fn() {
    const b = await book({ metadata: (m) => m.page!.size = "4in 8in" });
    const size = async () =>
      JSON.parse((await b.read("metadata.json"))!).page.size as string;
    const manuscript = await b.read("manuscript.md");
    const page = await openApp(b, "&mode=style&view=fonts");
    const historyBtn = page.getByRole("button", {
      name: "History",
      exact: true,
    });
    const banner = page.locator("#version-banner");
    const changes = page.locator("#history-changes");
    const historyParam = () => new URL(page.url()).searchParams.get("history");

    await historyBtn.click();
    await page.getByRole("button", { name: "Name this version…" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Tall");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.locator("#name-dlg").waitFor({ state: "hidden" });

    // Now the book is square, and the pocket edition changed too.
    let n = await laidOut(page);
    const meta = JSON.parse((await b.read("metadata.json"))!);
    meta.page.size = "6in 6in";
    await b.write("metadata.json", JSON.stringify(meta));
    const pocket = JSON.parse((await b.read("editions/pocket.json"))!);
    pocket.language = "fr";
    await b.write("editions/pocket.json", JSON.stringify(pocket));
    const pocketNow = await b.read("editions/pocket.json");
    n = await laidOut(page, n);
    assertEquals(await ratio(page), 1);

    const pickTall = async () => {
      await historyBtn.click();
      const tall = page.locator("#history-list .h-row", { hasText: "Tall" });
      const id = await tall.getAttribute("data-id");
      await tall.click();
      await until(() => historyParam() === id, "the version in the URL");
      n = await laidOut(page, n);
    };
    await pickTall();
    assertEquals(await ratio(page), 0.5);
    assert((await banner.innerText()).startsWith("Previewing Tall"));
    await changes.getByRole("heading", { name: "Tall" }).waitFor();
    assert(!await page.locator("#config-overlay").isVisible());
    assert(await page.locator('#modes [data-mode="write"]').isDisabled());
    assert(await page.locator("#undo").isDisabled());
    assertEquals(await size(), "6in 6in", "previewing writes nothing");

    await changes.getByRole("button", { name: "← Back to editing" }).click();
    await until(() => historyParam() === null, "editing again");
    const url = new URL(page.url()).searchParams;
    assertEquals([url.get("mode"), url.get("view")], ["style", "fonts"]);
    assert(await page.locator("#config-overlay").isVisible());
    assertEquals(await historyBtn.getAttribute("aria-pressed"), "false");
    n = await laidOut(page, n);
    assertEquals(await ratio(page), 1);

    await pickTall();
    await changes.getByRole("button", { name: "Restore ▾" }).click();
    await page.getByRole("menuitem", { name: /^Styles only/ }).click();
    await until(async () => await size() === "4in 8in", "the styles restored");
    assertEquals(await b.read("manuscript.md"), manuscript);
    assertEquals(await b.read("editions/pocket.json"), pocketNow);
    await until(() => historyParam() === null, "the preview ended");

    await banner.getByRole("button", { name: "Undo" }).click();
    await until(async () => await size() === "6in 6in", "the restore undone");
    await until(async () => await ratio(page) === 1, "the live pages again");
  },
});
