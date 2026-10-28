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
  extra = "", // appended to the manuscript
): Promise<void> {
  const root = await Deno.makeTempDir();
  const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
  const cp = await new Deno.Command("cp", {
    args: ["-R", fixture.pathname, root],
  }).output();
  assert(cp.success, "copy the fixture book");
  if (extra) {
    const md = `${root}/demo-book/manuscript.md`;
    await Deno.writeTextFile(md, (await Deno.readTextFile(md)) + extra);
  }
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

// The Contents pane's shown state, as the toolbar toggle reports it.
const treeShown = (page: Page) =>
  page.locator("#tree-toggle").getAttribute("aria-pressed");

Deno.test({
  name: "Ctrl+Shift+/ rebinds Contents to Ctrl+B, and it survives a reload",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page) => {
      const row = page.locator('#shortcuts-list [data-id="toggle-tree"]');
      await page.keyboard.press("Control+Shift+Slash");
      await row.click();
      await page.keyboard.press("Control+B");
      assertEquals(await row.locator("kbd").allTextContents(), ["Ctrl+B"]);
      await page.keyboard.press("Escape");
      assert(
        !(await page.locator("#shortcuts").evaluate((d) =>
          (d as HTMLDialogElement).open
        )),
      );
      const before = await treeShown(page);
      await page.keyboard.press("Control+B");
      assert((await treeShown(page)) !== before, "Ctrl+B toggles Contents");
      assert(
        (await page.locator("#tree-toggle").getAttribute("title"))?.endsWith(
          "(Ctrl+B)",
        ),
      );

      await page.reload();
      await page.locator("#editor .cm-content").waitFor();
      const after = await treeShown(page);
      await page.keyboard.press("Control+B");
      assert((await treeShown(page)) !== after, "still Ctrl+B after a reload");

      // Backspace on the row restores the default.
      await page.keyboard.press("Control+Shift+Slash");
      await row.click();
      await page.keyboard.press("Backspace");
      assertEquals(await row.locator("kbd").allTextContents(), ["Ctrl+\\"]);
    }),
});

Deno.test({
  name: "recording Ctrl+W says why and binds nothing",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page) => {
      const row = page.locator('#shortcuts-list [data-id="toggle-tree"]');
      await page.keyboard.press("Control+Shift+Slash");
      await row.click();
      await page.keyboard.press("Control+W");
      assertEquals(
        await page.locator("#shortcuts-note").textContent(),
        "Ctrl+W closes the browser tab; the page can't use it.",
      );
      await page.keyboard.press("Escape");
      assertEquals(await row.locator("kbd").allTextContents(), ["Ctrl+\\"]);
      assertEquals(
        await page.evaluate(() => localStorage.getItem("keys")),
        null,
      );
    }),
});

Deno.test({
  name:
    "a taken key comes back from a rebound command; an open dialog holds the keys",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page) => {
      const row = (id: string) =>
        page.locator(`#shortcuts-list [data-id="${id}"]`);
      await page.keyboard.press("Control+Shift+Slash");
      // Light / dark sits later in the table, so its rebind would win Ctrl+B.
      await row("theme").click();
      await page.keyboard.press("Control+B");
      await row("toggle-tree").click();
      await page.keyboard.press("Control+B");
      assertEquals(await row("toggle-tree").locator("kbd").allTextContents(), [
        "Ctrl+B",
      ]);
      assertEquals(
        await row("theme").locator(".sc-hint").allTextContents(),
        ["was Ctrl+B", "none"],
      );
      // The mode keys wait for the dialog to close.
      await page.keyboard.press("Control+2");
      assertEquals(await mode(page), "write");
      await page.keyboard.press("Control+Shift+Slash");
      await page.keyboard.press("Control+2");
      assertEquals(await mode(page), "style");
    }),
});

Deno.test({
  name: "Writing keys leave a text field outside the editor alone",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page) => {
      await page.evaluate(() => {
        const i = document.body.appendChild(document.createElement("input"));
        i.focus();
      });
      await page.keyboard.press("Control+K");
      assertEquals(await page.locator(".cm-bml-palette").count(), 0);
      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("Control+K");
      await page.locator(".cm-bml-palette").waitFor();
    }),
});

// Three chapters, each running over several pages.
const long = (
  "The hallway smelt of boiled cabbage and old rag mats. ".repeat(10) + "\n\n"
).repeat(12);
const chapters =
  ["two", "three"].map((c) =>
    `\n${long}\n\n{chapter: ${c}}\n{title}\nChapter ${c}\n`
  ).join("") + `\n${long}\n`;

Deno.test({
  name: "the new commands: theme, page and chapter steps, zoom, Style views",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withApp(async (page) => {
      const theme = () =>
        page.evaluate(() => document.documentElement.dataset.theme);
      const before = await theme();
      await page.keyboard.press("Control+Shift+L");
      assert((await theme()) !== before, "Ctrl+Shift+L flips the theme");

      // Laid out to the end: the last chapter is in, and the count holds.
      await page.locator("#preview .chapter", { hasText: "Chapter three" })
        .first().waitFor();
      for (let n = -1, was = -2; n !== was;) {
        was = n;
        await page.waitForTimeout(300);
        n = await page.locator("#preview .pagedjs_page").count();
      }
      // The footer's indicator names page n (it redraws a frame after a scroll).
      const at = (n: number) =>
        page.waitForFunction(
          (n) =>
            document.getElementById("page-indicator")!.textContent
              ?.startsWith(`Page ${n} `),
          n,
        );
      await at(1);
      await page.keyboard.press("Alt+BracketRight");
      await at(2);
      // Each chapter press lands on the next opening, centred in the pane.
      for (const id of ["two", "three"]) {
        await page.keyboard.press("Alt+Shift+BracketRight");
        const off = await page.evaluate((id) => {
          const c = document.getElementById("preview")!
            .getBoundingClientRect();
          const p = [
            ...document.querySelectorAll(
              "#preview > :not(.preview-stage) .chapter:not([data-split-from])",
            ),
          ].find((ch) => ch.textContent?.includes(`Chapter ${id}`))!
            .closest(".pagedjs_page")!.getBoundingClientRect();
          return Math.abs((p.top + p.bottom) / 2 - (c.top + c.bottom) / 2);
        }, id);
        assert(off < 40, `chapter ${id} is ${off}px off centre`);
      }
      await page.keyboard.press("Alt+Shift+BracketLeft");
      await page.keyboard.press("Alt+Shift+BracketLeft");
      await page.keyboard.press("Alt+BracketLeft");
      await at(1);

      const pct = page.locator('#zoom [data-zoom="menu"]');
      assertEquals(await pct.textContent(), "100%");
      await page.keyboard.press("Control+Equal");
      assert(parseInt((await pct.textContent()) ?? "") > 100, "zoomed in");
      await page.keyboard.press("Control+0");
      assertEquals(await pct.textContent(), "100%");

      await page.keyboard.press("Control+2");
      await page.keyboard.press("Control+Shift+1");
      await page.locator('#style-nav [aria-current="true"]', {
        hasText: "Theme",
      }).waitFor();
      await page.keyboard.press("Control+Shift+4");
      await page.locator('#style-nav [aria-current="true"]', {
        hasText: "Body",
      }).waitFor();
      // Export EPUB exists only in Publish, labelled there.
      await page.keyboard.press("Control+3");
      await page.locator('[data-command="export-epub"][title="Ctrl+Shift+E"]')
        .waitFor();
    }, chapters),
});
