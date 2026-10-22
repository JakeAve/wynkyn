// web/src/local-browser_test.ts — the hosted app with no server: dist/ as
// plain files, the book service running in the page over the browser's own
// storage. Imports the fixture book, edits it, and finds the edit in storage
// and again after a reload.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { unzipSync } from "fflate";
import { hasChrome } from "../../testing/chrome.ts";
import { serveSite } from "../../scripts/serve-site.ts";

const DIST = new URL("../../dist/", import.meta.url);
const siteBuilt = await Deno.stat(new URL("web/app.js", DIST))
  .then(() => true, () => false);

Deno.test({
  name: "local library: import into the browser, edit, the file changes, " +
    "the edit survives a reload",
  ignore: !hasChrome || !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      const url = `http://localhost:${site.addr.port}/`;
      await page.goto(url);
      await page.locator("#library[open]").waitFor();
      await page.locator("#lib-import").setInputFiles(
        new URL("../../server/testdata/demo-book", import.meta.url).pathname,
      );
      await page.locator('#status[data-kind="saved"]').waitFor();
      await page.locator("#preview .pagedjs_page").first().waitFor();
      assert(
        (await page.locator("#preview").innerText()).includes("Chapter One"),
      );

      const edit = page.locator("#editor .cm-content");
      await edit.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nA line typed in the browser.");
      const stored = () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const book = await root.getDirectoryHandle("demo-book");
          const fh = await book.getFileHandle("manuscript.md");
          return (await fh.getFile()).text();
        });
      const deadline = Date.now() + 10_000;
      while (!(await stored()).includes("typed in the browser")) {
        if (Date.now() > deadline) throw new Error("the edit never landed");
        await new Promise((r) => setTimeout(r, 50));
      }
      await page.locator('#status[data-kind="saved"]').waitFor();

      // Download: the book's folder as a zip, named after it.
      await page.locator("#book-switcher").click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator("#book-download").click(),
      ]);
      assertEquals(download.suggestedFilename(), "demo-book.zip");
      const zip = unzipSync(await Deno.readFile((await download.path())!));
      assert("demo-book/manuscript.md" in zip);
      assert(
        new TextDecoder().decode(zip["demo-book/manuscript.md"]).includes(
          "typed in the browser",
        ),
      );
      await page.keyboard.press("Escape");

      // The choice of library is remembered: no dialog, same book, the edit.
      await page.goto(`${url}?book=demo-book`);
      await page.locator('#status[data-kind="saved"]').waitFor();
      assertEquals(await page.locator("#library").isVisible(), false);
      assert(
        (await page.locator("#editor .cm-content").innerText()).includes(
          "typed in the browser",
        ),
      );
    } finally {
      await browser.close();
      await site.shutdown();
    }
  },
});
