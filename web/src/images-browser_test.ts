// web/src/images-browser_test.ts — image files dropped on the editor go in the
// book's images/ and come back as an {illustration} block, in the real app.
import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

// Writes the PNG as `root/name` for a file chooser (Playwright's in-memory
// payload wants a Node Buffer).
async function pngFile(root: string, name: string): Promise<string> {
  const path = `${root}/${name}`;
  await Deno.writeFile(
    path,
    Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
  );
  return path;
}

// Drops a DataTransfer on the editor line holding `text`: files by name (PNG
// bytes), or a plain text payload with no files.
function drop(
  page: Page,
  text: string,
  payload: { files?: string[]; text?: string },
): Promise<boolean> {
  return page.evaluate(({ text, payload, png }) => {
    const line = [...document.querySelectorAll("#editor .cm-line")]
      .find((l) => l.textContent?.includes(text))!;
    const r = line.getBoundingClientRect();
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    for (const name of payload.files ?? []) {
      dt.items.add(new File([bytes], name));
    }
    if (payload.text) dt.setData("text/plain", payload.text);
    // the line's last character: nearer its paragraph's end than its start
    const at = { clientX: r.right - 2, clientY: r.bottom - 4 };
    const fire = (type: string) =>
      line.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          ...at,
        }),
      );
    fire("dragover");
    return fire("drop"); // false when a handler took it (preventDefault)
  }, { text, payload, png: PNG });
}

Deno.test({
  name: "images: a dropped PNG becomes an illustration; a refused file doesn't",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const bookDir = `${root}/demo-book`;
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      let updates = 0; // rebuild pushes the page receives
      page.on("websocket", (ws) =>
        ws.on("framereceived", (f) => {
          if (String(f.payload).startsWith('{"type":"update"')) updates++;
        }));
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor({ timeout: 30_000 });
      await page.locator("#preview .preview-stage").waitFor({
        state: "detached",
      });
      await page.waitForTimeout(500); // let the first render's pushes settle
      updates = 0;

      // A refused file: nothing inserted, the refusal shown.
      assert(!await drop(page, "bright cold day", { files: ["photo.heic"] }));
      await page.locator("#image-note.warn", {
        hasText: "Only PNG, JPEG, WebP or SVG images can go in a book",
      }).waitFor();
      assert(
        !(await page.locator("#editor .cm-content").textContent())!
          .includes("photo"),
      );

      // A PNG: saved under its slug, a block after the paragraph, Caption
      // selected, and one pagination for the image and the save together.
      assert(
        !await drop(page, "bright cold day", { files: ["Night Sky.png"] }),
      );
      await page.locator("#image-note", {
        hasText: "Added to the book's images as night-sky.png",
      }).waitFor();
      assert((await Deno.stat(`${bookDir}/images/night-sky.png`)).isFile);
      assertEquals(
        await page.evaluate(() => document.getSelection()?.toString()),
        "Caption",
      );
      const block = "thirteen.\n\n{illustration: night-sky}\nCaption\n\n" +
        "{illustration: ornament";
      for (let i = 0; i < 50; i++) {
        if (
          (await Deno.readTextFile(`${bookDir}/manuscript.md`)).includes(block)
        ) break;
        await page.waitForTimeout(100);
      }
      assert(
        (await Deno.readTextFile(`${bookDir}/manuscript.md`)).includes(block),
        "the manuscript gains the block",
      );
      await page.waitForTimeout(2000); // any second push would land by now
      assertEquals(updates, 1, "one rebuild push per drop");

      // A drop with no files is CodeMirror's: it inserts the dragged text.
      assert(!await drop(page, "bright cold day", { text: "MOVED" }));
      assert(
        (await page.locator("#editor .cm-content").textContent())!
          .includes("MOVED"),
      );
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "images: the slug of an illustration completes from the book's images",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const bookDir = `${root}/demo-book`;
    // ornament.svg is in the text already; night-sky.png isn't
    await Deno.writeFile(
      `${bookDir}/images/night-sky.png`,
      Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
    );
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await page.locator("#preview > :not(.preview-stage) .pagedjs_page")
        .first().waitFor({ timeout: 30_000 });

      await page.locator("#editor .cm-line", { hasText: "Test Author" })
        .click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("{illustration: ");
      const list = page.locator("#editor .cm-tooltip-autocomplete");
      await list.locator("li", { hasText: "Add image" }).waitFor();
      assertEquals(
        await list.locator("completion-section").allTextContents(),
        ["Images in this book"],
      );
      const rows = await list.locator("li").allTextContents();
      assertEquals(rows.length, 3, "one row per image, then the add row");
      assert(rows.some((r) => r === "ornament"), "used: no note");
      assert(rows.some((r) => r === "night-skyNot in the text yet"));
      assertEquals(
        rows[2],
        "+Add image from your computer…Copies it into the book's images folder",
      );
      assertEquals(await list.locator("img.cm-bml-thumb").count(), 2);

      await list.locator("li", { hasText: "night-sky" }).click();
      const lines = await page.locator("#editor .cm-line").allTextContents();
      const at = lines.indexOf("Test Author");
      assertEquals(lines.slice(at, at + 3), [
        "Test Author",
        "",
        "{illustration: night-sky}",
      ]);

      // After placement: the two placements that lay out.
      await page.keyboard.type(" | placement: ");
      await list.locator("li", { hasText: "inline" }).waitFor();
      assertEquals(await list.locator("li").allTextContents(), [
        "full-pagea page of its own",
        "inlinein the text",
      ]);

      // The add row: the picked file goes in images/, its slug in the tag.
      await page.keyboard.press("Escape");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("{illustration: ");
      const chooser = page.waitForEvent("filechooser");
      await list.locator("li", { hasText: "Add image" }).click();
      await (await chooser).setFiles(await pngFile(root, "Harbour.png"));
      await page.locator("#editor .cm-line", {
        hasText: "{illustration: harbour",
      }).waitFor();
      assert((await Deno.stat(`${bookDir}/images/harbour.png`)).isFile);
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "images: an empty placeholder takes a picked or dropped image (Write)",
  ignore: !hasChrome || !appBuilt,
  async fn() {
    const root = await Deno.makeTempDir();
    const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
    const cp = await new Deno.Command("cp", {
      args: ["-R", fixture.pathname, root],
    }).output();
    assert(cp.success, "copy the fixture book");
    const bookDir = `${root}/demo-book`;
    const tag = "{illustration: harbour | placement: inline}";
    await Deno.writeTextFile(
      `${bookDir}/manuscript.md`,
      `\n${tag}\nThe Harbour\n\n{illustration: pier}\n`,
      { append: true },
    );
    const server = await startServer({ booksRoot: root, port: 0 });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      const live = "#preview > :not(.preview-stage)";
      const empty = page.locator(
        `${live} .illustration-placeholder[data-slug="harbour"]`,
      );
      await empty.waitFor({ timeout: 30_000 });
      assertEquals(
        await empty.locator("span").allTextContents(),
        ["No image named harbour yet", "Click to add one"],
      );

      const chooser = page.waitForEvent("filechooser");
      await empty.click();
      const picker = await chooser;
      assertEquals(
        await page.locator("#editor .cm-activeLine").textContent(),
        tag,
        "the click puts the cursor on the illustration's line",
      );
      await picker.setFiles(await pngFile(root, "Some Photo.png"));
      // Saved under the placeholder's slug; the rebuild (held ~1.2 s for an
      // images-only change) shows the image.
      await page.locator(`${live} figure#harbour img`).waitFor({
        timeout: 30_000,
      });
      assert((await Deno.stat(`${bookDir}/images/harbour.png`)).isFile);
      assertEquals(await empty.count(), 0);

      // A file dropped on a placeholder goes in under its slug too.
      const taken = await page.evaluate(({ live, png }) => {
        const el = document.querySelector(
          `${live} .illustration-placeholder[data-slug="pier"]`,
        )!;
        const dt = new DataTransfer();
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], "dock.png"));
        const fire = (type: string) =>
          el.dispatchEvent(
            new DragEvent(type, {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
        return !fire("dragover") && !fire("drop");
      }, { live, png: PNG });
      assert(taken, "the preview takes the drop");
      await page.locator(`${live} figure#pier img`).waitFor({
        timeout: 30_000,
      });
      assert((await Deno.stat(`${bookDir}/images/pier.png`)).isFile);
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
