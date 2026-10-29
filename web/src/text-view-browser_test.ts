// web/src/text-view-browser_test.ts — the write pane's header in the real app
// (design-language.md §8): Prose | Source by the control and by ⌘/, Source in
// monospace, the choice kept across a reload, and the Aa size.
import { assert, assertEquals } from "@std/assert";
import type { Page } from "playwright";
import { appTest, book, openApp } from "../../testing/app.ts";

const view = (page: Page) => page.locator("#editor").getAttribute("data-view");
const lineFont = (page: Page) =>
  // a line of writing: in Prose the cursor's paragraph shows its markup in mono
  page.locator("#editor .cm-line:not(.cm-prose-src)").first().evaluate((el) =>
    getComputedStyle(el).fontFamily
  );

appTest({
  name: "Prose | Source switches by the control and ⌘/, and persists",
  async fn() {
    const page = await openApp(await book());
    assertEquals(await view(page), "prose");
    assert(!/monospace/.test(await lineFont(page)), "Prose is the writing");

    await page.locator('#tv-views [data-view="source"]').click();
    assertEquals(await view(page), "source");
    assert(/monospace/.test(await lineFont(page)), "Source is monospace");
    assertEquals(
      await page.locator('#tv-views [data-view="source"]').getAttribute(
        "aria-checked",
      ),
      "true",
    );

    // ⌘/ in the editor flips it back, and is not CodeMirror's comment toggle.
    const before = await page.locator("#editor .cm-content").textContent();
    await page.locator("#editor .cm-content").click();
    await page.keyboard.press("ControlOrMeta+Slash");
    assertEquals(await view(page), "prose");
    await page.locator('#tv-views [data-view="source"]').click();
    assertEquals(
      await page.locator("#editor .cm-content").textContent(),
      before,
    );
    await page.locator("#editor .cm-content").click();
    await page.keyboard.press("ControlOrMeta+Slash");
    assertEquals(await view(page), "prose");
    await page.keyboard.press("ControlOrMeta+Slash");
    assertEquals(await view(page), "source");
    assertEquals(
      await page.locator("#editor .cm-content").textContent(),
      before,
    );

    // The Aa menu opens, takes a size, and esc closes it.
    await page.locator("#tv-aa").click();
    await page.locator("#tv-aa-pop").waitFor();
    await page.locator('#tv-aa-pop [data-step="1"]').click();
    assertEquals(await page.locator("#tv-size").textContent(), "18");
    await page.keyboard.press("Escape");
    await page.locator("#tv-aa-pop").waitFor({ state: "hidden" });

    await page.reload();
    await page.locator("#editor .cm-line").first().waitFor();
    assertEquals(await view(page), "source");
    assertEquals(await page.locator("#tv-size").textContent(), "18");
  },
});
