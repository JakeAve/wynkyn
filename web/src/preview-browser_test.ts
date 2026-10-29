// web/src/preview-browser_test.ts — the preview's loading states in the real
// app: the render finishes without requestAnimationFrame (a background tab
// never fires it), an edit dims the pages until the re-render lands, and an
// edit or a style change lays out only the segments it reaches.
import { assert, assertEquals } from "@std/assert";
import { appTest, book, openApp } from "../../testing/app.ts";
import { newPage } from "../../testing/chrome.ts";
import { laidOut, until } from "../../testing/wait.ts";

appTest({
  name: "preview: renders with no animation frames; edits dim the old pages",
  async fn() {
    const b = await book();
    const page = await newPage();
    // Like a hidden tab: animation frames never come. Only Paged.js must
    // not depend on them; the editor and chrome keep working regardless.
    await page.addInitScript(() => {
      globalThis.requestAnimationFrame = () => 0;
    });
    await page.goto(b.url());
    const first = await laidOut(page);

    await page.locator("#editor .cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" edited");
    await page.locator("#preview[data-stale]").waitFor();
    // The save lands, the server rebuilds, the render swaps in: undimmed.
    await laidOut(page, first);
  },
});

appTest({
  name: "preview: the pages on screen keep their look while the next renders",
  async fn() {
    const b = await book();
    const page = await openApp(b);
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

    const meta = JSON.parse((await b.read("metadata.json"))!);
    meta.fonts.body = "Libre Caslon Text";
    await b.write("metadata.json", JSON.stringify(meta, null, 2));
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
  },
});

appTest({
  name:
    "preview: an edit lays out one segment, its undo and a reload none, a title-page font one",
  async fn() {
    const chapter = (slug: string, title: string) =>
      `{chapter: ${slug}}\n{title}\n${title}\n\nSome words in ${title}.\n`;
    const b = await book({
      manuscript: [
        "{matter: title-page}\n{title}\nDemo Book\n",
        "{matter: toc}\n{title}\nContents\n",
        chapter("one", "Chapter One"),
        chapter("two", "Chapter Two"),
        chapter("three", "Chapter Three"),
      ].join("\n"),
    });
    const page = await newPage();
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
    await page.goto(b.url());
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
    const meta = JSON.parse((await b.read("metadata.json"))!);
    meta.fonts.title = "Cinzel";
    meta.elements["title-page"] = { title: { "font-family": "title" } };
    let n = await laidOut(page);
    await b.write("metadata.json", JSON.stringify(meta, null, 2));
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
  },
});

appTest({
  name: "preview: a counter in the book's CSS lays the book out whole",
  async fn() {
    const chapter = (slug: string) =>
      `{chapter: ${slug}}\n{title}\n${slug}\n\nSome words.\n`;
    const page = await openApp(
      await book({
        manuscript: ["one", "two", "three"].map(chapter).join("\n"),
        // Paged.js's Counters handler writes a rule per run for each chapter.
        metadata: (meta) => {
          meta.elements = {
            ...meta.elements,
            chapter: { "counter-increment": "chap" },
          };
        },
      }),
    );
    assertEquals(
      await page.locator("#preview").evaluate((el) =>
        (el as HTMLElement).dataset.segmentsLaid
      ),
      "1",
      "the first segment, then the book whole",
    );
  },
});
