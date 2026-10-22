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
      // Reading while the page's writable stream is mid-commit throws
      // NotReadableError (seen on the CI runner); that just means not yet.
      const stored = () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const book = await root.getDirectoryHandle("demo-book");
          const fh = await book.getFileHandle("manuscript.md");
          try {
            return await (await fh.getFile()).text();
          } catch (e) {
            if ((e as DOMException).name === "NotReadableError") return "";
            throw e;
          }
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

      // The e-book is built in the page: a blob link, no server.
      await page.locator('#modes [data-mode="publish"]').click();
      await page.getByRole("button", { name: "Export EPUB" }).click();
      const link = page.locator(".export-status a", { hasText: "book.epub" });
      await link.waitFor();
      assert((await link.getAttribute("href"))!.startsWith("blob:"));
      await page.locator('#modes [data-mode="write"]').click();

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

Deno.test({
  name: "local library: a browser without the File System Access API " +
    "gets the banner and no folder button",
  ignore: !hasChrome || !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        delete (globalThis as any).showDirectoryPicker;
      });
      await page.goto(`http://localhost:${site.addr.port}/`);
      await page.locator("#library[open]").waitFor();
      assertEquals(await page.locator("#lib-pick").isVisible(), false);
      assertEquals(await page.locator("#browser-banner").isVisible(), true);
      // The modal library dialog sits over the banner until a library is chosen.
      await page.locator("#lib-import").setInputFiles(
        new URL("../../server/testdata/demo-book", import.meta.url).pathname,
      );
      await page.locator('#status[data-kind="saved"]').waitFor();
      await page.locator("#browser-banner-close").click();
      assertEquals(await page.locator("#browser-banner").isVisible(), false);
    } finally {
      await browser.close();
      await site.shutdown();
    }
  },
});
