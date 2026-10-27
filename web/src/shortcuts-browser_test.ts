// web/src/shortcuts-browser_test.ts — the command table in the real app, on
// Windows (navigator.platform emulated): mod is Ctrl alone, labels read
// Ctrl+…, and the Writing keys still beat CodeMirror's own.
import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

// The demo book open in Write, as on Windows.
async function withApp(
  fn: (page: Page, saved: (has: string) => Promise<void>) => Promise<void>,
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
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "platform", { get: () => "Win32" })
    );
    await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
    await page.locator("#editor .cm-content").waitFor();
    // Waits for the manuscript on disk to hold `has` (saves are debounced).
    const file = `${root}/demo-book/manuscript.md`;
    const saved = async (has: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await Deno.readTextFile(file)).includes(has)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`never saved ${has}`);
    };
    await fn(page, saved);
  } finally {
    await browser.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
}

const mode = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.mode);

Deno.test({
  name: "on Windows mod is Ctrl alone, and labels say Ctrl",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page) => {
      await page.keyboard.press("Meta+2");
      assertEquals(await mode(page), "write");
      await page.keyboard.press("Control+2");
      assertEquals(await mode(page), "style");
      await page.keyboard.press("Control+1");
      assertEquals(await mode(page), "write");
      const title = await page.locator("#tree-toggle").getAttribute("title");
      assert(title?.endsWith("(Ctrl+\\)"), `title: ${title}`);
      // panes.ts retitles the writing's corner; the key follows it.
      const corner = page.locator('#editor .expand[data-pane="writing"]');
      assertEquals(
        await corner.getAttribute("title"),
        "Expand the writing; esc returns (Ctrl+Shift+Enter)",
      );
      await page.keyboard.press("Control+Period");
      await page.waitForFunction(() =>
        document.querySelector('#editor .expand[data-pane="writing"]')!
          .getAttribute("title") === "Show the pages (Ctrl+.)"
      );
      assertEquals(
        await page.locator('#modes [data-mode="style"]').getAttribute(
          "aria-keyshortcuts",
        ),
        "Control+2 Control+,",
      );
    }),
});

Deno.test({
  name: "Ctrl+Shift+F inserts a footnote and Ctrl+I emphasises the selection",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page, saved) => {
      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nZanzibar");
      await page.keyboard.press("Shift+Home");
      // The wrap bar's keys come from the label pass.
      assertEquals(
        await page.locator(".cm-bml-wrapbar kbd").first().textContent(),
        "Ctrl+I",
      );
      await page.keyboard.press("Control+I");
      await saved("{em}Zanzibar{/em}");
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Control+Shift+F");
      await saved("{footnote: name}");
    }),
});
