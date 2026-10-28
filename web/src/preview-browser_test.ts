// web/src/preview-browser_test.ts — the preview's loading states in the real
// app: the render finishes without requestAnimationFrame (a background tab
// never fires it), an edit dims the pages until the re-render lands, and an
// edit or a style change lays out only the segments it reaches.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";
import { laidOut, until } from "../../testing/wait.ts";

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
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      const first = await laidOut(page);

      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" edited");
      await page.locator("#preview[data-stale]").waitFor();
      // The save lands, the server rebuilds, the render swaps in: undimmed.
      await laidOut(page, first);
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "preview: the pages on screen keep their look while the next renders",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const metaPath = `${root}/demo-book/metadata.json`;
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await laidOut(page);
      // While a render is staged — the moment it is added, then every 10ms —
      // the face of the pages on screen. Recorded in the page, so a render
      // that comes and goes between two polls from here is still caught.
      await page.evaluate(() => {
        const el = document.getElementById("preview")!;
        const seen = new Set<string>();
        const sample = () => {
          if (!el.querySelector(".preview-stage")) return;
          Object.assign(globalThis, { staged: true });
          const p = el.querySelector(":scope > :not(.preview-stage) p");
          if (p) seen.add(getComputedStyle(p).fontFamily);
        };
        Object.assign(globalThis, { seen, staged: false });
        new MutationObserver(sample).observe(el, { childList: true });
        setInterval(sample, 10);
      });

      const meta = JSON.parse(await Deno.readTextFile(metaPath));
      meta.fonts.body = "Libre Caslon Text";
      await Deno.writeTextFile(metaPath, JSON.stringify(meta, null, 2));
      await page.waitForFunction(
        () =>
          // deno-lint-ignore no-explicit-any
          (globalThis as any).staged &&
          !document.querySelector("#preview .preview-stage"),
        undefined,
        { timeout: 30_000 },
      );
      const seen = await page.evaluate(() => // deno-lint-ignore no-explicit-any
      [...(globalThis as any).seen as Set<string>]);
      assert(seen.length > 0, "sampled the pages mid-render");
      assert(
        seen.every((f) => f.includes("EB Garamond")),
        `the old pages kept their face: ${seen.join(" | ")}`,
      );
      const now = await page.locator("#preview .pagedjs_page p").first()
        .evaluate((p) => getComputedStyle(p).fontFamily);
      assert(now.includes("Libre Caslon"), `the new pages: ${now}`);
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "preview: an edit lays out one segment, its undo and a reload none, a title-page font one",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const chapter = (slug: string, title: string) =>
      `{chapter: ${slug}}\n{title}\n${title}\n\nSome words in ${title}.\n`;
    await Deno.writeTextFile(
      `${root}/demo-book/manuscript.md`,
      [
        "{matter: title-page}\n{title}\nDemo Book\n",
        "{matter: toc}\n{title}\nContents\n",
        chapter("one", "Chapter One"),
        chapter("two", "Chapter Two"),
        chapter("three", "Chapter Three"),
      ].join("\n"),
    );
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      // The book's cache manifest's segment keys, once one is saved.
      const savedKeys = () =>
        page.evaluate(() =>
          new Promise<string | null>((resolve) => {
            const req = indexedDB.open("preview-cache");
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains("books")) return resolve(null);
              const get = db.transaction("books").objectStore("books").getAll();
              get.onsuccess = () =>
                resolve(
                  get.result.length
                    ? JSON.stringify(
                      get.result.map((b) =>
                        b.segments.map((s: { key: string }) => s.key)
                      ),
                    )
                    : null,
                );
            };
          })
        );
      const laid = () =>
        page.locator("#preview").evaluate((el) =>
          Number((el as HTMLElement).dataset.segmentsLaid ?? 0)
        );
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      const first = await laidOut(page);
      // Every segment, then the contents again with the folios it read.
      const cold = await laid();
      assertEquals(cold, 6, "five segments and the contents' second pass");
      let keys: string | null = null;
      await until(async () => (keys = await savedKeys()) !== null, "a save");

      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(" edited");
      await page.locator("#preview[data-stale]").waitFor();
      await laidOut(page, first);
      assertEquals(await laid(), cold + 1, "only the edited chapter");
      await until(async () => await savedKeys() !== keys, "the edit's save");

      await page.reload();
      // The restore, then the first update's paint, which it answers.
      await laidOut(page, 1);
      assertEquals(await laid(), 0, "nothing laid out after a reload");
      assert(
        await page.locator("#preview .pagedjs_page", { hasText: "edited" })
          .count() > 0,
        "the restored pages carry the edit",
      );

      // A style reaching only the title page lays out only the title page.
      const metaPath = `${root}/demo-book/metadata.json`;
      const meta = JSON.parse(await Deno.readTextFile(metaPath));
      meta.fonts.title = "Cinzel";
      meta.elements["title-page"] = { title: { "font-family": "title" } };
      let n = await laidOut(page);
      await Deno.writeTextFile(metaPath, JSON.stringify(meta, null, 2));
      n = await laidOut(page, n);
      assertEquals(await laid(), 1, "only the title page");
      const face = await page.locator("#preview .matter-title-page .title")
        .first().evaluate((t) => getComputedStyle(t).fontFamily);
      assert(face.includes("Cinzel"), `the title's face: ${face}`);

      // An edit, then its undo: the undo finds the old pages in the cache.
      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(" again");
      await page.locator("#preview[data-stale]").waitFor();
      n = await laidOut(page, n);
      assertEquals(await laid(), 2, "only the edited chapter");
      await page.keyboard.press("ControlOrMeta+z");
      await page.locator("#preview[data-stale]").waitFor();
      await laidOut(page, n);
      assertEquals(await laid(), 2, "the undo lays out nothing");
      assertEquals(
        await page.locator("#preview .pagedjs_page", { hasText: "again" })
          .count(),
        0,
        "the undone pages",
      );
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
