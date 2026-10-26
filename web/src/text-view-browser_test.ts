// web/src/text-view-browser_test.ts — the write pane's header in the real app
// (design-language.md §8): Prose | Source by the control and by ⌘/, Source in
// monospace, the choice kept across a reload, and old saved prefs migrated.
import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

// The demo book open in Write; `saved` is what localStorage holds first.
async function withApp(
  saved: string | null,
  fn: (page: Page) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
  const cp = await new Deno.Command("cp", {
    args: ["-R", fixture.pathname, root],
  }).output();
  assert(cp.success, "copy the fixture book");
  const server = await startServer({ booksRoot: root, port: 0 });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    if (saved !== null) {
      await page.addInitScript(
        (v) => localStorage.setItem("text-view", v),
        saved,
      );
    }
    await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
    await page.locator("#editor .cm-line").first().waitFor();
    await fn(page);
  } finally {
    await browser.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
}

const view = (page: Page) => page.locator("#editor").getAttribute("data-view");
const lineFont = (page: Page) =>
  // a line of writing: in Prose the cursor's paragraph shows its markup in mono
  page.locator("#editor .cm-line:not(.cm-prose-src)").first().evaluate((el) =>
    getComputedStyle(el).fontFamily
  );

Deno.test({
  name: "Prose | Source switches by the control and ⌘/, and persists",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(null, async (page) => {
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
    }),
});

Deno.test({
  name: "old text view prefs load: mono is Source, hide is dropped",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp('{"font":"mono","hide":true}', async (page) => {
      assertEquals(await view(page), "source");
      assert(/monospace/.test(await lineFont(page)));
      const saved = JSON.parse(
        await page.evaluate(() => localStorage.getItem("text-view")) ?? "{}",
      );
      assertEquals(saved.view, "source");
      assert(!("hide" in saved) && !("font" in saved));
    }),
});
