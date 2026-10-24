// web/src/themes-browser_test.ts — a theme previewed and applied in the real
// app (spec §7.5): previewing writes nothing and holds live pushes, Discard
// restores the book's look, and Apply asks: a new edition, a replace, or
// Cancel.
import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

Deno.test({
  name: "themes: preview holds pushes and saves nothing; Apply asks first",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const dir = `${root}/demo-book`;
    const metaPath = `${dir}/metadata.json`;
    const server = await startServer({
      booksRoot: root,
      port: 0,
      saveDebounceMs: 0,
    });
    const browser = await chromium.launch({ channel: "chrome" });
    const editions = () =>
      [...Deno.readDirSync(`${dir}/editions`)].map((e) => e.name).sort();
    const until = async (ok: () => Promise<boolean>, what: string) => {
      for (let i = 0; i < 100 && !await ok(); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(await ok(), what);
    };
    // The body face of the pages on screen, once no render is staged.
    const settled = async (page: Page) => {
      await page.locator("#preview .preview-stage").waitFor({
        state: "detached",
        timeout: 30_000,
      });
      await page.locator("#preview[data-stale]").waitFor({
        state: "detached",
        timeout: 30_000,
      });
    };
    const liveFont = (page: Page) =>
      page.locator("#preview > :not(.preview-stage) .pagedjs_page p").first()
        .evaluate((p) => getComputedStyle(p).fontFamily);
    const liveText = (page: Page) =>
      page.locator("#preview > :not(.preview-stage)").first().innerText();
    try {
      const page = await browser.newPage();
      const app = `http://localhost:${server.port}/app/?book=demo-book`;
      await page.goto(`${app}&mode=style&view=themes`);
      await page.locator("#preview .pagedjs_page").first().waitFor({
        timeout: 30_000,
      });
      await settled(page);
      assert((await liveFont(page)).includes("EB Garamond"));
      const metaBefore = await Deno.readTextFile(metaPath);
      const edsBefore = await editions();

      // Preview: the pages take Caslon, the bar says so, nothing is written.
      const bar = page.locator("#theme-bar");
      const caslon = page.locator('#config-overlay .tcard[data-slug="caslon"]');
      await caslon.click();
      await bar.waitFor();
      assertEquals(
        (await bar.innerText()).replace(/\s+/g, " ").trim(),
        "Previewing Caslon Apply… Discard",
      );
      assertEquals(await caslon.getAttribute("aria-pressed"), "true");
      await until(
        async () => (await liveFont(page)).includes("Libre Caslon"),
        "the preview shows Caslon",
      );
      await settled(page);
      assertEquals(await Deno.readTextFile(metaPath), metaBefore);
      assertEquals(await editions(), edsBefore);

      // A manuscript change mid-preview is built in the theme, not the book.
      const ms = `${dir}/manuscript.md`;
      await Deno.writeTextFile(
        ms,
        (await Deno.readTextFile(ms)).replace("thirteen", "fourteen"),
      );
      await until(
        async () => (await liveText(page)).includes("fourteen"),
        "the pushed text reaches the preview",
      );
      await settled(page);
      assert((await liveFont(page)).includes("Libre Caslon"));
      assert(await bar.isVisible());

      // Discard: the book's own look, with the held push, and no bar.
      await page.getByRole("button", { name: "Discard" }).click();
      await bar.waitFor({ state: "hidden" });
      await until(
        async () => (await liveFont(page)).includes("EB Garamond"),
        "Discard restores the book's look",
      );
      assert((await liveText(page)).includes("fourteen"));
      assertEquals(await caslon.getAttribute("aria-pressed"), "false");
      assertEquals(await Deno.readTextFile(metaPath), metaBefore);

      // Apply… asks; Cancel changes nothing and keeps the preview.
      await caslon.click();
      await bar.waitFor();
      await page.getByRole("button", { name: "Apply…" }).click();
      const dlg = page.locator("#theme-dlg");
      await dlg.waitFor();
      const copy = (await dlg.innerText()).replace(/\s+/g, " ");
      for (
        const line of [
          "Apply Caslon to Standard?",
          "Fonts, part styles, chapter numbering and running heads change. " +
          "Page size, margins and your custom styles stay.",
          "Apply as new edition",
          "Standard stays as it is. A new edition, Caslon, gets this theme.",
          "Replace this edition's style",
          "Standard's current fonts and styles are replaced. This can't be " +
          "undone.",
          "Cancel",
        ]
      ) assert(copy.includes(line), `dialog says: ${line}`);
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "hidden" });
      assert(await bar.isVisible());
      assertEquals(await Deno.readTextFile(metaPath), metaBefore);
      assertEquals(await editions(), edsBefore);

      // Replace: metadata.json takes Caslon's fonts; page stays as it was.
      await page.getByRole("button", { name: "Apply…" }).click();
      await dlg.getByRole("button", { name: /Replace this edition/ }).click();
      await dlg.waitFor({ state: "hidden" });
      await bar.waitFor({ state: "hidden" });
      await until(async () => {
        const m = JSON.parse(await Deno.readTextFile(metaPath));
        return m.fonts?.body === "Libre Caslon Text";
      }, "Replace saves Caslon's fonts");
      const after = JSON.parse(await Deno.readTextFile(metaPath));
      assertEquals(
        JSON.stringify(after.page),
        JSON.stringify(JSON.parse(metaBefore).page),
      );
      assertEquals(await editions(), edsBefore);

      // Apply as new edition: editions/aldine.json, and the app moves to it.
      await page.locator('#config-overlay .tcard[data-slug="aldine"]').click();
      await bar.waitFor();
      await page.getByRole("button", { name: "Apply…" }).click();
      await dlg.getByRole("button", { name: /Apply as new edition/ }).click();
      await page.waitForURL(/edition=aldine/);
      const aldine = JSON.parse(
        await Deno.readTextFile(`${dir}/editions/aldine.json`),
      );
      const themes = JSON.parse(
        await Deno.readTextFile(
          new URL("../../templates/themes.json", import.meta.url),
        ),
      );
      const want = themes.find((t: { slug: string }) => t.slug === "aldine");
      for (const [alias, family] of Object.entries(want.fonts ?? {})) {
        assertEquals(aldine.fonts[alias], family);
      }
      assertEquals(
        JSON.stringify(aldine.page),
        JSON.stringify(JSON.parse(metaBefore).page),
      );
      // The book it came from is left as Replace made it.
      assertEquals(
        JSON.parse(await Deno.readTextFile(metaPath)).fonts.body,
        "Libre Caslon Text",
      );
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
