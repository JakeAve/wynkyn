// web/src/history-browser_test.ts — the History takeover in the real app:
// name a version, preview it on the pages, restore its styles only, undo
// that from the pages' banner, and Esc back to Write.
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
  name: "history: preview a styles version, restore its styles, undo, Esc",
  async fn() {
    const b = await book({ metadata: (m) => m.page!.size = "4in 8in" });
    const size = async () =>
      JSON.parse((await b.read("metadata.json"))!).page.size as string;
    const manuscript = await b.read("manuscript.md");
    const page = await openApp(b);

    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.getByRole("button", { name: "Name…" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Tall");
    await page.getByRole("button", { name: "Save name" }).click();
    const tall = page.locator("#history-list .h-row", { hasText: "Tall" });
    await tall.waitFor();

    // The book now is square; "now" shows the live pages.
    let n = await laidOut(page);
    const meta = JSON.parse((await b.read("metadata.json"))!);
    meta.page.size = "6in 6in";
    await b.write("metadata.json", JSON.stringify(meta));
    n = await laidOut(page, n);
    assertEquals(await ratio(page), 1);

    const id = await tall.getAttribute("data-id");
    await tall.click();
    await until(
      () => new URL(page.url()).searchParams.get("history") === id,
      "the version in the URL",
    );
    n = await laidOut(page, n);
    assertEquals(await ratio(page), 0.5);
    assert(
      (await page.locator("#version-banner").innerText()).startsWith(
        "Previewing",
      ),
    );
    assertEquals(await size(), "6in 6in", "previewing writes nothing");
    assert(await page.locator("#undo").isDisabled());

    await page.getByRole("button", { name: "Restore ▾" }).click();
    await page.getByRole("menuitem", { name: /^Styles only/ }).click();
    await until(async () => await size() === "4in 8in", "the styles restored");
    assertEquals(await b.read("manuscript.md"), manuscript);

    await page.locator("#version-banner").getByRole("button", { name: "Undo" })
      .click();
    await until(async () => await size() === "6in 6in", "the restore undone");

    await page.keyboard.press("Escape");
    await until(
      () =>
        page.evaluate(() => !("history" in document.documentElement.dataset)),
      "History closed",
    );
    assertEquals(new URL(page.url()).searchParams.get("history"), null);
    assert(await page.locator("#editor").isVisible());
    await laidOut(page, n);
    await until(async () => await ratio(page) === 1, "the live pages again");
  },
});
