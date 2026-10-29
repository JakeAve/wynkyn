// server/themes-browser_test.ts — every preset theme on demo-book builds and
// paginates in Chrome with no page-map problems.
import { assertEquals } from "@std/assert";
import { buildBook } from "./pipeline.ts";
import { toHtml } from "./export-html.ts";
import { applyTheme, THEMES } from "../metadata/themes.ts";
import { chromeTest, newPage } from "../testing/chrome.ts";

const DEMO = new URL("./testdata/demo-book/", import.meta.url).pathname;

chromeTest({
  name: "every theme on demo-book paginates to data-paged=done",
  async fn() {
    const root = await Deno.makeTempDir();
    const dir = `${root}/demo-book`;
    await Deno.mkdir(`${dir}/images`, { recursive: true });
    await Deno.copyFile(`${DEMO}manuscript.md`, `${dir}/manuscript.md`);
    await Deno.copyFile(
      `${DEMO}images/ornament.svg`,
      `${dir}/images/ornament.svg`,
    );
    const meta = JSON.parse(await Deno.readTextFile(`${DEMO}metadata.json`));
    try {
      for (const t of THEMES) {
        await Deno.writeTextFile(
          `${dir}/metadata.json`,
          JSON.stringify(applyTheme(meta, t.slug)),
        );
        const built = await buildBook(root, "demo-book", {
          imageUrlPrefix: `file://${dir}/images`,
        });
        const file = `${root}/${t.slug}.html`;
        await Deno.writeTextFile(file, toHtml(built));
        const page = await newPage();
        await page.goto(`file://${file}`);
        await page.waitForSelector("html[data-paged]", { timeout: 120_000 });
        assertEquals(
          await page.getAttribute("html", "data-paged"),
          "done",
          `${t.slug}: ${await page.getAttribute("html", "data-paged-report")}`,
        );
        await page.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
