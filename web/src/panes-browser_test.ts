// web/src/panes-browser_test.ts — the panes' chrome in the real app (spec
// §7.1): each pane expands from its corner and returns by the same button or
// esc, the expanded preview still lays out, and ⌘. hides the pages with no
// toolbar button.
import { assert, assertEquals } from "@std/assert";
import type { Page } from "playwright";
import { appTest, book, openApp } from "../../testing/app.ts";
import { eventually } from "../../testing/wait.ts";

// The demo book open in Write with its pages laid out.
async function withApp(fn: (page: Page) => Promise<void>): Promise<void> {
  await fn(await openApp(await book()));
}

const panesClass = (page: Page) =>
  page.locator("#panes").getAttribute("class").then((c) => c ?? "");
const visibility = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => getComputedStyle(el).visibility);

appTest({
  name:
    "expanding the writing hides tree and pages but the preview still lays out",
  fn: () =>
    withApp(async (page) => {
      await page.locator('#editor .expand[data-pane="writing"]').click();
      assert((await panesClass(page)).includes("expand-writing"));
      // The outline slides out (a transition), then is hidden.
      await page.waitForFunction(() =>
        getComputedStyle(document.getElementById("tree")!).visibility ===
          "hidden"
      );
      assertEquals(await visibility(page, "#preview"), "hidden");
      const editor = await page.locator("#editor").boundingBox();
      const panes = await page.locator("#panes").boundingBox();
      assertEquals(editor?.width, panes?.width, "the writing takes the row");

      // An edit while expanded still lands on the hidden pages.
      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("\nZanzibar");
      const live = page.locator("#preview > :not(.preview-stage)").first();
      await eventually(async () =>
        assert(
          (await live.textContent() ?? "").includes("Zanzibar"),
          "the preview laid out the edit",
        )
      );

      // Persisted per mode: Style doesn't inherit it, Write gets it back.
      await page.keyboard.press("ControlOrMeta+2");
      await page.waitForFunction(() =>
        !document.getElementById("panes")!.className.includes("expand")
      );
      await page.keyboard.press("ControlOrMeta+1");
      await page.waitForFunction(() =>
        document.getElementById("panes")!.className.includes("expand-writing")
      );
    }),
});

appTest({
  name: "esc and the corner button return from expanded",
  fn: () =>
    withApp(async (page) => {
      const corner = page.locator('#pages .expand[data-pane="pages"]');
      await corner.click();
      assert((await panesClass(page)).includes("expand-pages"));
      assertEquals(await corner.getAttribute("aria-pressed"), "true");
      assertEquals(await visibility(page, "#editor"), "hidden");
      await page.keyboard.press("Escape");
      assert(!(await panesClass(page)).includes("expand"));
      assertEquals(await corner.getAttribute("aria-pressed"), "false");

      // Expanded, the Contents button pins the outline instead.
      await corner.click();
      await page.locator("#tree-toggle").click();
      assert((await panesClass(page)).includes("pin-outline"));
      await corner.click();
      assert(!(await panesClass(page)).includes("expand"));

      // ⌘⇧↩ expands the pane last used (the pages, clicked), then returns.
      await page.keyboard.press("ControlOrMeta+Shift+Enter");
      assert((await panesClass(page)).includes("expand-pages"));
      await page.keyboard.press("ControlOrMeta+Shift+Enter");
      assert(!(await panesClass(page)).includes("expand"));
    }),
});

appTest({
  name: "⌘. still hides the pages without a toolbar button",
  fn: () =>
    withApp(async (page) => {
      assertEquals(await page.locator("#toolbar #pages-toggle").count(), 0);
      await page.keyboard.press("ControlOrMeta+Period");
      assert((await panesClass(page)).includes("pages-hidden"));
      assertEquals(await visibility(page, "#preview"), "hidden");
      assert(
        await page.locator("#preview .pagedjs_page").count() > 0,
        "the hidden preview keeps its pages",
      );
      await page.keyboard.press("ControlOrMeta+Period");
      assert(!(await panesClass(page)).includes("pages-hidden"));
    }),
});

appTest({
  name: "with the pages hidden, the writing's corner button shows them",
  fn: () =>
    withApp(async (page) => {
      const corner = page.locator('#editor .expand[data-pane="writing"]');
      await page.keyboard.press("ControlOrMeta+Period");
      assert((await panesClass(page)).includes("pages-hidden"));
      assertEquals(await corner.getAttribute("aria-pressed"), "true");
      assert(
        (await corner.getAttribute("aria-label"))!.startsWith("Show the pages"),
      );
      await corner.click();
      const cls = await panesClass(page);
      assert(!cls.includes("pages-hidden") && !cls.includes("expand"));
      assertEquals(await corner.getAttribute("aria-pressed"), "false");
      assertEquals(
        await corner.getAttribute("aria-label"),
        "Expand the writing",
      );
    }),
});

appTest({
  name: "the pages hide in Write only: Style shows them and ⌘. leaves them",
  fn: () =>
    withApp(async (page) => {
      const mode = (m: string) =>
        page.locator(`#modes [data-mode="${m}"]`).click();
      await page.keyboard.press("ControlOrMeta+Period");
      assert((await panesClass(page)).includes("pages-hidden"));
      await mode("style");
      assert(!(await panesClass(page)).includes("pages-hidden"));
      await page.keyboard.press("ControlOrMeta+Period");
      assert(!(await panesClass(page)).includes("pages-hidden"));
      await mode("write");
      assert((await panesClass(page)).includes("pages-hidden"));
    }),
});

appTest({
  name: "arrow keys on a focused gutter resize the column",
  fn: () =>
    withApp(async (page) => {
      const gutter = page.locator("#gutter-tree");
      const tree = () => page.locator("#tree").evaluate((e) => e.clientWidth);
      const rem = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize)
      );
      const before = await tree();
      await gutter.focus();
      await page.keyboard.press("ArrowRight");
      assertEquals(await tree(), Math.round(before + rem));
      assertEquals(
        Number(await gutter.getAttribute("aria-valuenow")),
        Math.round(before + rem),
      );
      assertEquals(
        await page.evaluate(() => localStorage.getItem("--w-tree")),
        `${before + rem}px`,
      );
      // The minimum holds: 7.5rem, however many presses.
      for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
      assertEquals(await tree(), Math.round(7.5 * rem));
    }),
});
