// web/src/preview-browser_test.ts — the preview's loading states in the real
// app: the render finishes without requestAnimationFrame (a background tab
// never fires it), and an edit dims the pages until the re-render lands.
import { assert } from "@std/assert";
import { chromium } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

Deno.test({
  name: "preview: renders with no animation frames; edits dim the old pages",
  ignore: !hasChrome || !appBuilt,
  async fn() {
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
      // Like a hidden tab: animation frames never come. Only Paged.js must
      // not depend on them; the editor and chrome keep working regardless.
      await page.addInitScript(() => {
        globalThis.requestAnimationFrame = () => 0;
      });
      await page.goto(`http://localhost:${server.port}/?book=demo-book`);
      const live = page.locator(
        "#preview > :not(.preview-stage) .pagedjs_page",
      );
      await live.first().waitFor({ timeout: 30_000 });
      await page.locator("#preview .preview-stage").waitFor({
        state: "detached",
      });
      assert(!await page.locator("#preview[data-stale]").count());

      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" edited");
      await page.locator("#preview[data-stale]").waitFor();
      // The save lands, the server rebuilds, the render swaps in: undimmed.
      await page.locator("#preview[data-stale]").waitFor({
        state: "detached",
        timeout: 30_000,
      });
      await page.locator("#preview .preview-stage").waitFor({
        state: "detached",
      });
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
