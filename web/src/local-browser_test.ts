// web/src/local-browser_test.ts — the hosted app with no server: dist/ as
// plain files, the book service running in the page over the browser's own
// storage. Imports the fixture book, edits it, and finds the edit in storage
// and again after a reload.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { chromium } from "playwright";
import { unzipSync } from "fflate";
import { hasChrome } from "../../testing/chrome.ts";
import { serveSite } from "../../scripts/serve-site.ts";

const DIST = new URL("../../dist/", import.meta.url);
const siteBuilt = await Deno.stat(new URL("web/app.js", DIST))
  .then(() => true, () => false);

// A browser-storage library with the fixture book copied in from disk, the
// way a browser without the folder picker gets its books.
async function importDemoBook(page: import("playwright").Page): Promise<void> {
  await page.locator("#lib-browser").click();
  await page.locator("#create[open]").waitFor();
  await page.locator("#create-dir").setInputFiles(
    new URL("../../server/testdata/demo-book", import.meta.url).pathname,
  );
}

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
      await importDemoBook(page);
      await page.locator('#status[data-kind="saved"]').waitFor();
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor();
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
    "gets the notice, tagged folder buttons, and Import from a folder in the browser",
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
      // The notice comes first, on its own; the Welcome waits for it.
      await page.locator("#browser-notice[open]").waitFor();
      assertEquals(await page.locator("#library[open]").count(), 0);
      await page.locator("#browser-notice-close").click();
      await page.locator("#library[open]").waitFor();
      // The folder buttons are tagged, not hidden; a click fails with the
      // browser's own error.
      assert(await page.locator("#lib-pick .pill").isVisible());
      await page.locator("#lib-pick").click();
      await page.locator("#lib-err:not(:empty)").waitFor();
      assertStringIncludes(
        (await page.locator("#lib-err").textContent()) ?? "",
        "showDirectoryPicker",
      );
      // An empty library's Create dialog has a Back to the Welcome, and for
      // browser storage an Import from a folder.
      await page.locator("#lib-browser").click();
      await page.locator("#create[open]").waitFor();
      assert(await page.locator("#create-folder").isVisible());
      await page.locator("#create-back").click();
      await page.locator("#library[open]").waitFor();
      await importDemoBook(page);
      await page.locator('#status[data-kind="saved"]').waitFor();
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor();
      assert(
        (await page.locator("#preview").innerText()).includes("Chapter One"),
      );
      // Dismissed once, the notice stays away.
      await page.reload();
      await page.locator('#status[data-kind="saved"]').waitFor();
      assertEquals(await page.locator("#browser-notice[open]").count(), 0);
    } finally {
      await browser.close();
      await site.shutdown();
    }
  },
});

const TINY = `Title: Tiny Book

Author: A. Writer

*** START OF THE PROJECT GUTENBERG EBOOK TINY BOOK ***

CHAPTER I.
The Start

It was a dark and stormy night.

CHAPTER II.
The End

And then it was over.

*** END OF THE PROJECT GUTENBERG EBOOK TINY BOOK ***
`;

Deno.test({
  name: "first run: Welcome → browser storage → import a text file → title → " +
    "the editor, with import notes in the footer",
  ignore: !hasChrome || !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    const browser = await chromium.launch({ channel: "chrome" });
    const tmp = await Deno.makeTempDir();
    const file = `${tmp}/tiny-book.txt`;
    await Deno.writeTextFile(file, TINY);
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${site.addr.port}/`);
      await page.locator("#library[open]").waitFor();
      const welcome = await page.locator("#library").innerText();
      assert(
        welcome.includes("Your books are yours"),
        `the privacy line is on the Welcome: ${welcome}`,
      );
      await page.locator("#lib-browser").click();
      // An empty library goes straight to Create a new manuscript.
      await page.locator("#create[open]").waitFor();
      assert(
        await page.locator("#create-cancel").isHidden(),
        "no Cancel on an empty library",
      );
      await page.locator("#create-file").setInputFiles(file);
      await page.locator("#title-dlg[open]").waitFor();
      assertEquals(
        await page.locator("#title-input").inputValue(),
        "Tiny Book",
      );
      assertEquals(await page.locator("#title-slug").innerText(), "tiny-book/");
      await page.locator("#title-ok").click();

      await page.waitForURL(/book=tiny-book/);
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor();
      const text = await page.locator("#editor .cm-content").innerText();
      assert(text.includes("{chapter: the-start}"), "the import landed");
      assert(text.includes("%% check:"), "guesses are flagged");
      const notes = page.locator("#import-notes");
      await notes.waitFor({ state: "visible" });
      assert(
        (await notes.innerText()).includes("import note"),
        "the footer counts the notes",
      );
      await notes.click();
      await page.locator("#import-notes-list button").first().click();
      assert(
        await page.locator("#import-notes-list").isHidden(),
        "picking a note closes the list",
      );

      // The switcher's New book runs the same dialog, now with a Cancel.
      await page.locator("#book-switcher").click();
      await page.locator("#book-new").click();
      await page.locator("#create[open]").waitFor();
      assert(
        await page.locator("#create-cancel").isVisible(),
        "Cancel once the library has a book",
      );
      await page.locator("#create-blank").click();
      await page.locator("#title-dlg[open]").waitFor();
      await page.locator("#title-input").fill("Tiny Book");
      await page.locator("#title-ok").click();
      assert(
        (await page.locator("#title-err").innerText()).includes("taken"),
        "a taken slug is refused",
      );
      await page.locator("#title-input").fill("Second Book");
      await page.locator("#title-ok").click();
      await page.waitForURL(/book=second-book/);
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor();
      assert(
        (await page.locator("#editor .cm-content").innerText()).includes(
          "Second Book",
        ),
        "the blank book opens on its title",
      );
      await page.close();
    } finally {
      await browser.close();
      await site.shutdown();
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "local library: a picked folder is named in the switcher, and " +
    "Change library… goes back to the Welcome with it on offer",
  ignore: !hasChrome || !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      // The picker can't be driven, so it hands out a private-storage folder
      // named like the author's: same handle API, no dialog.
      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        (globalThis as any).showDirectoryPicker = async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle("My Books", { create: true });
        };
      });
      await page.goto(`http://localhost:${site.addr.port}/`);
      await page.locator("#library[open]").waitFor();
      // With the picker there is no Chromium-only tag.
      assertEquals(await page.locator("#lib-pick .pill").isVisible(), false);
      await page.locator("#lib-pick").click();
      await page.locator("#create[open]").waitFor();
      await page.locator("#create-blank").click();
      await page.locator("#title-dlg[open]").waitFor();
      await page.locator("#title-input").fill("Tiny");
      await page.locator("#title-input").press("Enter");
      await page.locator('#status[data-kind="saved"]').waitFor();
      await page.locator("#book-switcher").click();
      await page.locator("#library-note").waitFor();
      await page.waitForFunction(() =>
        document.getElementById("library-note")!.textContent!.includes(
          "“My Books”",
        )
      );
      await page.locator("#library-open").click();
      await page.locator("#library[open]").waitFor();
      assertStringIncludes(
        (await page.locator("#lib-reopen").textContent()) ?? "",
        "My Books",
      );
    } finally {
      await browser.close();
      await site.shutdown();
    }
  },
});
