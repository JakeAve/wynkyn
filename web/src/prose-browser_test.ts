// web/src/prose-browser_test.ts — the Prose view in the real app
// (design-language.md §8.1): rubrics in the margin, markup folded outside the
// cursor's block and revealed at it, ⁂ for a break, ☞ for a note.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

const MANUSCRIPT = `Opening words, where the cursor starts.

{chapter: one}
{title}
Chapter One

{dropcap}
It was a bright cold day in April, and the clocks were {em}striking{/em} thirteen.
%% check: thirteen, as in the source.

{break}

After the break.
`;

Deno.test({
  name: "Prose draws rubrics, ⁂ and ☞, and reveals markup at the cursor",
  ignore: !hasChrome || !appBuilt,
  fn: async () => {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    await Deno.writeTextFile(`${root}/demo-book/manuscript.md`, MANUSCRIPT);
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await page.locator("#editor .cm-line").first().waitFor();
      assertEquals(
        await page.locator("#editor").getAttribute("data-view"),
        "prose",
      );
      const shown = () => page.locator("#editor .cm-content").innerText();

      const chapter = page.locator(
        '#editor .cm-prose-rubric[data-label="Chapter"]',
      );
      assertEquals(await chapter.count(), 1);
      let text = await shown();
      assert(!text.includes("{chapter"), "the chapter line is folded");
      assert(!text.includes("{em}"), "em tags are folded");
      assert(text.includes("⁂"), "a break is ⁂");
      assertEquals(await page.locator("#editor .cm-prose-note").count(), 1);
      assertEquals(
        await page.locator("#editor .cm-prose-note").getAttribute("title"),
        "check: thirteen, as in the source.",
      );

      await page.locator("#editor .cm-line", { hasText: "Chapter One" })
        .click();
      text = await shown();
      assert(text.includes("{chapter: one}"), "the cursor reveals the block");
      assert(text.includes("{title}"));
      assert(!text.includes("{break}"), "other blocks stay folded");
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
