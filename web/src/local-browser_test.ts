// web/src/local-browser_test.ts — the hosted app with no server: dist/ as
// plain files, the book service running in the page over the browser's own
// storage. Imports the fixture book, edits it, and finds the edit in storage
// and again after a reload.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { strToU8, unzipSync, zipSync } from "fflate";
import { chromeTest, newPage } from "../../testing/chrome.ts";
import { eventually, until } from "../../testing/wait.ts";
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

chromeTest({
  name: "local library: import into the browser, edit, the file changes, " +
    "the edit survives a reload",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    try {
      const page = await newPage();
      // An OPFS folder stands in for the picker, which can't be driven.
      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        (globalThis as any).showDirectoryPicker = async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle("My Books", { create: true });
        };
      });
      const url = `http://localhost:${site.addr.port}/app/`;
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
      await until(
        async () => (await stored()).includes("typed in the browser"),
        "the edit to land",
      );
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
      const [all] = await Promise.all([
        page.waitForEvent("download"),
        page.locator("#library-download").click(),
      ]);
      assert(
        "Books/demo-book/manuscript.md" in
          unzipSync(await Deno.readFile((await all.path())!)),
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

      await page.locator("#library-open").click();
      await page.locator("#library[open]").waitFor();
      await page.locator("#lib-pick").click();
      await page.locator("#bring[open]").waitFor();
      await page.locator("#bring-copy").click();
      await page.locator("#choose[open]").waitFor();
      assertEquals(
        await page.locator('#choose-list [aria-selected="true"]')
          .getAttribute("title"),
        "demo-book",
      );
      await page.keyboard.press("Enter");
      await page.waitForURL(/book=demo-book/);
      await page.locator("#library-name", { hasText: "My Books" }).waitFor();
      const copied = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle("My Books");
        const book = await dir.getDirectoryHandle("demo-book");
        const fh = await book.getFileHandle("manuscript.md");
        return await (await fh.getFile()).text();
      });
      assertStringIncludes(copied, "typed in the browser");
    } finally {
      await site.shutdown();
    }
  },
});

chromeTest({
  name: "local library: a browser without the File System Access API " +
    "gets the notice, tagged folder buttons, and Import from a folder in the browser",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    try {
      const page = await newPage();
      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        delete (globalThis as any).showDirectoryPicker;
      });
      await page.goto(`http://localhost:${site.addr.port}/app/`);
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
      // The crumb starts with the library: this browser, and its warning.
      assertEquals(
        await page.locator("#library-name").textContent(),
        "This browser",
      );
      assertEquals(
        await page.locator("#library-icon").getAttribute("href"),
        "#where-browser",
      );
      // Dismissed once, the notice stays away.
      await page.reload();
      await page.locator('#status[data-kind="saved"]').waitFor();
      assertEquals(await page.locator("#browser-notice[open]").count(), 0);
    } finally {
      await site.shutdown();
    }
  },
});

// A Word file with a heading style, a picture and a footnote.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const docx = (): Uint8Array => {
  const p = (body: string, style = "") =>
    `<w:p>${
      style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""
    }${body}</w:p>`;
  const r = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const chapter = (n: string) => p(r(`Chapter ${n}`), "Heading1");
  return zipSync({
    "word/document.xml": strToU8(
      `<w:document><w:body>${
        chapter("One") +
        p(
          r("A sentence with a note.") +
            `<w:r><w:footnoteReference w:id="1"/></w:r>`,
        ) +
        p(`<w:r><w:drawing><wp:docPr id="1" name="P" descr="A dot"/><a:blip r:embed="rId1"/></w:drawing></w:r>`) +
        chapter("Two") + p(r("The end of it."))
      }</w:body></w:document>`,
    ),
    "word/styles.xml": strToU8(
      `<w:styles><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    ),
    "word/footnotes.xml": strToU8(
      `<w:footnotes><w:footnote w:id="1"><w:p>${
        r("The note.")
      }</w:p></w:footnote></w:footnotes>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>`,
    ),
    "word/media/image1.png": PNG,
  });
};

chromeTest({
  name: "import a Word file: the typed title, its picture and its footnote " +
    "reach the pages",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    const tmp = await Deno.makeTempDir();
    const file = `${tmp}/Manuscript_final_v3.docx`;
    await Deno.writeFile(file, docx());
    try {
      const page = await newPage();
      await page.goto(`http://localhost:${site.addr.port}/app/`);
      await page.locator("#library[open]").waitFor();
      await page.locator("#lib-browser").click();
      await page.locator("#create[open]").waitFor();
      await page.locator("#create-file").setInputFiles(file);
      await page.locator("#title-dlg[open]").waitFor({ timeout: 5000 }).catch(
        async (e) => {
          throw new Error(
            `${await page.locator("#create-err").innerText()} (${e})`,
          );
        },
      );
      assertEquals(
        await page.locator("#title-input").inputValue(),
        "Manuscript_final_v3",
        "a Word file rarely names its title: the file name stands in",
      );
      await page.locator("#title-input").fill("The Long Way");
      await page.locator("#title-ok").click();

      await page.waitForURL(/book=the-long-way/, { timeout: 5000 }).catch(
        async (e) => {
          throw new Error(
            `${await page.locator("#create-err").innerText()} (${e})`,
          );
        },
      );
      const live = "#preview > :not(.preview-stage) .pagedjs_page";
      await page.locator(`${live} img`).first().waitFor();
      const pages = page.locator(live);
      assertEquals(
        (await pages.first().innerText()).trim(),
        "The Long Way",
        "the typed title, not the file name, is the book's",
      );
      assert(
        await page.locator(`${live} img`).first().evaluate((i) =>
          (i as HTMLImageElement).naturalWidth > 0
        ),
        "the picture was saved with the book and loads",
      );
      const text = await page.locator("#preview > :not(.preview-stage)")
        .innerText();
      assertStringIncludes(text, "The note.");
      const tree = await page.locator("#tree").innerText();
      assert(
        tree.includes("Chapter One") || tree.includes("one"),
        `chapters from Heading 1: ${tree}`,
      );
      await page.close();
    } finally {
      await site.shutdown();
      await Deno.remove(tmp, { recursive: true });
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

chromeTest({
  name: "first run: Welcome → browser storage → import a text file → title → " +
    "the editor, with import notes in the footer",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    const tmp = await Deno.makeTempDir();
    const file = `${tmp}/tiny-book.txt`;
    await Deno.writeTextFile(file, TINY);
    try {
      const page = await newPage();
      await page.goto(`http://localhost:${site.addr.port}/app/`);
      await page.locator("#library[open]").waitFor();
      const welcome = await page.locator("#library").innerText();
      assert(
        welcome.includes("Your books are yours"),
        `the privacy line is on the Welcome: ${welcome}`,
      );
      // A dialog opens with its title focused, no row pre-chosen.
      const focused = () => page.evaluate(() => document.activeElement?.id);
      assertEquals(await focused(), "library-title");
      await page.locator("#lib-browser").click();
      // An empty library goes straight to Create a new manuscript.
      await page.locator("#create[open]").waitFor();
      assertEquals(await focused(), "create-title");
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
      // The tree, not the editor's DOM: CodeMirror draws only the lines near
      // the viewport, so how far down a chapter is depends on the text size.
      // It and the notes follow the parse, which waits on a debounce.
      await eventually(async () => {
        const tree = await page.locator("#tree").innerText();
        assert(
          tree.includes("The Start") && tree.includes("The End"),
          `the import landed: ${tree}`,
        );
      });
      // In Prose a `%%` note is a ☞ in the margin, its text in the title.
      await eventually(async () => {
        const flags = await page.locator("#editor .cm-prose-note")
          .evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
        assert(flags.some((t) => t.includes("check:")), "guesses are flagged");
      });
      const notes = page.locator("#import-notes");
      await notes.waitFor({ state: "visible" });
      assert(
        (await notes.innerText()).includes("import note"),
        "the footer counts the notes",
      );
      // From Style, where the editor is hidden, a note opens Write at it.
      await page.locator('#modes [data-mode="style"]').click();
      await notes.click();
      await page.locator("#import-notes-list button").first().click();
      assert(
        await page.locator("#import-notes-list").isHidden(),
        "picking a note closes the list",
      );
      await page.locator('html[data-mode="write"]').waitFor({
        state: "attached",
      });
      await page.locator("#editor .cm-activeLine", { hasText: "%% check:" })
        .waitFor();

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
      await site.shutdown();
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

chromeTest({
  name: "import from the web: a fetched address, and a paste when the site " +
    "blocks the page",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    try {
      const page = await newPage();
      const address = "https://books.example/tiny.txt";
      await page.route(address, (r) =>
        r.fulfill({
          body: TINY,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "access-control-allow-origin": "*",
          },
        }));
      await page.route("https://blocked.example/**", (r) => r.abort());
      await page.goto(`http://localhost:${site.addr.port}/app/`);
      await page.locator("#library[open]").waitFor();
      await page.locator("#lib-browser").click();
      await page.locator("#create[open]").waitFor();

      // An address that allows the fetch goes straight to the title.
      await page.locator("#create-web").click();
      await page.locator("#web-dlg[open]").waitFor();
      await page.locator("#web-url").fill(address);
      await page.locator("#web-fetch").click();
      await page.locator("#title-dlg[open]").waitFor();
      assertEquals(
        await page.locator("#title-input").inputValue(),
        "Tiny Book",
      );
      assertStringIncludes(
        (await page.locator("#title-source").textContent()) ?? "",
        address,
      );
      await page.locator("#title-ok").click();
      await page.waitForURL(/book=tiny-book/);
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor();
      assert(
        (await page.locator("#editor .cm-content").innerText()).startsWith(
          `%% Imported from ${address}`,
        ),
        "the manuscript remembers where it came from",
      );

      // A site that blocks the page offers a paste instead.
      await page.locator("#book-switcher").click();
      await page.locator("#book-new").click();
      await page.locator("#create[open]").waitFor();
      await page.locator("#create-web").click();
      await page.locator("#web-dlg[open]").waitFor();
      await page.locator("#web-url").fill("https://blocked.example/book");
      await page.locator("#web-fetch").click();
      await page.locator("#web-paste-box").waitFor({ state: "visible" });
      assertEquals(
        await page.locator("#web-open").getAttribute("href"),
        "https://blocked.example/book",
      );
      await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        document.getElementById("web-paste")!.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, TINY);
      await page.locator("#title-dlg[open]").waitFor();
      assert(
        ((await page.locator("#title-source").textContent()) ?? "")
          .startsWith("Pasted from"),
      );
      await page.locator("#title-input").fill("Tiny Book Two");
      await page.locator("#title-ok").click();
      await page.waitForURL(/book=tiny-book-two/);
    } finally {
      await site.shutdown();
    }
  },
});

chromeTest({
  name: "local library: a picked folder is named in the switcher and in " +
    "Change library, and offered again once its permission lapses",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    try {
      const page = await newPage();
      // The picker can't be driven, so it hands out a private-storage folder
      // named like the author's: same handle API, no dialog.
      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        (globalThis as any).showDirectoryPicker = async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle("My Books", { create: true });
        };
      });
      await page.goto(`http://localhost:${site.addr.port}/app/`);
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
      await page.locator(".book-row").first().waitFor();
      for (
        const id of ["#book-download", "#library-download", "#library-note"]
      ) {
        assertEquals(await page.locator(id).isVisible(), false);
      }
      await page.keyboard.press("Escape"); // the switcher covers the toolbar
      // The folder icon centers on the name's caps, not its line box.
      const offset = await page.evaluate(async () => {
        await document.fonts.ready;
        const mid = (r: DOMRect) => (r.top + r.bottom) / 2;
        const probe = document.createElement("span");
        probe.style.cssText = "display: inline-block; height: 1cap";
        const name = document.getElementById("library-name")!;
        name.append(probe);
        const icon = document.querySelector("#library-open svg")!;
        const off = mid(icon.getBoundingClientRect()) -
          mid(probe.getBoundingClientRect());
        probe.remove();
        return off;
      });
      assert(Math.abs(offset) <= 0.5, `the icon is ${offset}px off the caps`);
      // The crumb's first step names the folder, and says where in its title.
      const lib = page.locator("#library-open");
      assertEquals(
        await page.locator("#library-name").textContent(),
        "My Books",
      );
      assertEquals(
        await page.locator("#library-icon").getAttribute("href"),
        "#where-folder",
      );
      assertStringIncludes(
        (await lib.getAttribute("title")) ?? "",
        "“My Books”",
      );
      // A mark that a reload would wipe.
      // deno-lint-ignore no-explicit-any
      await page.evaluate(() => (globalThis as any).stayed = true);
      await lib.click();
      await page.locator("#library[open]").waitFor();
      assertStringIncludes(
        (await page.locator("#lib-now").textContent()) ?? "",
        "My Books",
      );
      await page.locator("#lib-cancel").click();
      await page.locator("#library").waitFor({ state: "hidden" });
      // deno-lint-ignore no-explicit-any
      assert(await page.evaluate(() => (globalThis as any).stayed));
      assertStringIncludes(page.url(), "book=tiny");
      assertEquals(await page.locator("#book-name").textContent(), "Tiny");

      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        (FileSystemHandle.prototype as any).queryPermission = () =>
          Promise.resolve("prompt");
      });
      await page.reload();
      await page.locator("#library[open]").waitFor();
      await page.getByRole("button", { name: /Open My Books again/ }).click();
      await page.locator('#status[data-kind="saved"]').waitFor();
      assertEquals(await page.locator("#book-name").textContent(), "Tiny");
    } finally {
      await site.shutdown();
    }
  },
});

// The fixture book, then a blank "Other" opened from the switcher: the page
// ends on Other, saved, with demo-book a switch away.
async function twoBooks(page: import("playwright").Page): Promise<void> {
  await page.locator("#library[open]").waitFor();
  await importDemoBook(page);
  await page.locator('#status[data-kind="saved"]').waitFor();
  await page.locator("#book-switcher").click();
  await page.locator("#book-new").click();
  await page.locator("#create[open]").waitFor();
  await page.locator("#create-blank").click();
  await page.locator("#title-dlg[open]").waitFor();
  await page.locator("#title-input").fill("Other");
  await page.locator("#title-ok").click();
  await page.waitForURL(/book=other/);
  await page.locator('#status[data-kind="saved"]').waitFor();
}

// What the browser's storage holds for a book's manuscript ("" mid-commit).
const storedManuscript = (page: import("playwright").Page, book: string) =>
  page.evaluate(async (book) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(book);
    const fh = await dir.getFileHandle("manuscript.md");
    try {
      return await (await fh.getFile()).text();
    } catch (e) {
      if ((e as DOMException).name === "NotReadableError") return "";
      throw e;
    }
  }, book);

async function switchToDemoBook(page: import("playwright").Page) {
  await page.locator("#book-switcher").click();
  await page.locator('.book-row[title="demo-book"]').dblclick();
}

chromeTest({
  name: "local library: an edit typed just before switching book is saved",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    try {
      const page = await newPage();
      await page.goto(`http://localhost:${site.addr.port}/app/`);
      await twoBooks(page);
      // Writes to storage wait until let through, so the edit is unsaved
      // when the switch starts however slow the run: its debounce or its
      // save is still pending, never landed already.
      await page.evaluate(() => {
        const p = FileSystemFileHandle.prototype;
        const real = p.createWritable;
        const gate = new Promise<void>((open) =>
          // deno-lint-ignore no-explicit-any
          (globalThis as any).letWritesThrough = open
        );
        p.createWritable = async function (...args) {
          await gate;
          return real.apply(this, args);
        };
      });
      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nTyped just before the switch.");
      await switchToDemoBook(page);
      // deno-lint-ignore no-explicit-any
      await page.evaluate(() => (globalThis as any).letWritesThrough());
      await page.waitForURL(/book=demo-book/);
      assertStringIncludes(
        await storedManuscript(page, "other"),
        "Typed just before the switch.",
      );
    } finally {
      await site.shutdown();
    }
  },
});

chromeTest({
  name: "local library: switching with a save that fails asks first; " +
    "staying keeps the edit and the retry lands it",
  ignore: !siteBuilt,
  async fn() {
    const site = serveSite(DIST, 0);
    try {
      const page = await newPage();
      await page.goto(`http://localhost:${site.addr.port}/app/`);
      await twoBooks(page);
      // Every write to storage fails until put back.
      await page.evaluate(() => {
        const p = FileSystemFileHandle.prototype;
        // deno-lint-ignore no-explicit-any
        (globalThis as any).realCreateWritable = p.createWritable;
        p.createWritable = () =>
          Promise.reject(new DOMException("disk full", "QuotaExceededError"));
      });
      await page.locator("#editor .cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nTyped while saves fail.");
      const asked = new Promise<string>((resolve) =>
        page.once("dialog", async (d) => {
          resolve(`${d.type()}: ${d.message()}`);
          await d.dismiss();
        })
      );
      await switchToDemoBook(page);
      assertEquals(
        await asked,
        "confirm: Some changes aren't saved. Leave anyway?",
      );
      assert(page.url().includes("book=other"), "staying stays");
      await page.locator('#status[data-kind="error"]').waitFor();
      assert(
        (await page.locator("#editor .cm-content").innerText()).includes(
          "Typed while saves fail.",
        ),
        "the edit is still in the editor",
      );

      await page.evaluate(() => {
        FileSystemFileHandle.prototype.createWritable =
          // deno-lint-ignore no-explicit-any
          (globalThis as any).realCreateWritable;
      });
      await page.locator('#status[data-kind="saved"]').waitFor();
      assertStringIncludes(
        await storedManuscript(page, "other"),
        "Typed while saves fail.",
      );
    } finally {
      await site.shutdown();
    }
  },
});
