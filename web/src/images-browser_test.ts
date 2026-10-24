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
