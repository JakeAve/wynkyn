// web/src/publish-browser_test.ts — the Publish view's Folios each stepper in
// the real app: a plain count saves as one (never "5pt"), and on a true fold it
// steps by whole folded sheets.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

Deno.test({
  name: "publish: Folios each saves a count, by whole sheets on a quarto",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    // A page that folds as a folio or a quarto of legal; folio to start.
    const metaPath = `${root}/demo-book/metadata.json`;
    const meta = JSON.parse(await Deno.readTextFile(metaPath));
    Object.assign(meta.page, {
      size: "4.25in 7in",
      sheet: "legal",
      fold: "folio",
    });
    await Deno.writeTextFile(metaPath, JSON.stringify(meta, null, 2));
    const server = await startServer({
      booksRoot: root,
      port: 0,
    });
    const browser = await chromium.launch({ channel: "chrome" });
    const saved = async () =>
      JSON.parse(await Deno.readTextFile(metaPath))
        .page["folios-per-signature"];
    // Saves are debounced in the page, so wait for the file to catch up.
    const until = async (want: number) => {
      for (let i = 0; i < 50 && await saved() !== want; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assertEquals(await saved(), want);
    };
    try {
      const page = await browser.newPage();
      await page.goto(
        `http://localhost:${server.port}/app/?book=demo-book&mode=publish`,
      );
      const input = page.getByLabel("Folios per signature", { exact: true });
      const more = page.getByLabel("Increase Folios per signature");
      const less = page.getByLabel("Decrease Folios per signature");
      await input.waitFor();
      assertEquals(await input.inputValue(), "4");

      await more.click(); // a folio: one sheet a folio, so 4 → 5
      assertEquals(await input.inputValue(), "5");
      await until(5);

      await input.fill("7"); // typed, too
      await input.press("Enter");
      await until(7);

      // A quarto's sheet is two folios: presses land on even counts.
      await page.getByLabel("Fold", { exact: true }).selectOption("quarto");
      await more.click();
      assertEquals(await input.inputValue(), "8");
      await less.click();
      await less.click();
      assertEquals(await input.inputValue(), "4");
      await until(4);
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
