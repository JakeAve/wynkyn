// web/src/images-browser_test.ts — image files dropped on the editor go in the
// book's images/ and come back as an {illustration} block, in the real app.
import { assert, assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import { appTest, book, type TestBook } from "../../testing/app.ts";
import { newPage } from "../../testing/chrome.ts";
import { laidOut, quietFor, until } from "../../testing/wait.ts";

// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

// The PNG as a file chooser's pick: Playwright's payload wants a Node Buffer.
const pngFile = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(PNG, "base64"),
});

const hasImage = async (b: TestBook, name: string) =>
  await b.read(`images/${name}`) !== null;

async function imageCount(b: TestBook): Promise<number> {
  const res = await fetch(
    `${new URL(b.url()).origin}/api/books/${b.slug}/images`,
  );
  return (await res.json()).images.length;
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

appTest({
  name: "images: a dropped PNG becomes an illustration; a refused file doesn't",
  async fn() {
    const b = await book();
    const page = await newPage();
    // Rebuild pushes, by the text they were built from: a slow first
    // render can still be pushing when the drop goes in.
    const pushed: string[] = [];
    page.on("websocket", (ws) =>
      ws.on("framereceived", (f) => {
        const m = JSON.parse(String(f.payload));
        if (m.type === "update") pushed.push(m.manuscriptVersion);
      }));
    await page.goto(b.url());
    await laidOut(page);
    const opening = new Set(pushed);

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
    assert(await hasImage(b, "night-sky.png"));
    assertEquals(
      await page.evaluate(() => document.getSelection()?.toString()),
      "Caption",
    );
    const block = "thirteen.\n\n{illustration: night-sky}\nCaption\n\n" +
      "{illustration: ornament";
    await until(
      async () => (await b.read("manuscript.md"))!.includes(block),
      "the manuscript to gain the block",
    );
    // The push of the saved text, matched by its version; any new text
    // pushed ahead of it was a pagination of its own.
    await page.locator('#status[data-kind="saved"]').waitFor();
    const { version } = await (await fetch(
      new URL(`/api/books/${b.slug}/manuscript`, b.url()),
    )).json();
    await until(() => pushed.includes(version), "the save's push");
    assertEquals(
      pushed.slice(0, pushed.indexOf(version) + 1)
        .filter((v) => !opening.has(v)),
      [version],
      "one rebuild push per drop",
    );
    // Prose lists the images again after the drop and draws the new one.
    await page.locator(
      '#editor .cm-prose-illustration img[src$="night-sky.png"]',
    ).waitFor();

    // A drop with no files is CodeMirror's: it inserts the dragged text.
    assert(!await drop(page, "bright cold day", { text: "MOVED" }));
    assert(
      (await page.locator("#editor .cm-content").textContent())!
        .includes("MOVED"),
    );

    // A paste from Word or Pages, a picture of the text beside the text:
    // the text goes in, no image does.
    const before = await imageCount(b);
    await page.locator("#editor .cm-line", { hasText: "Test Author" })
      .click();
    await page.evaluate((png) => {
      const dt = new DataTransfer();
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
      dt.setData("text/plain", "PASTED WORDS");
      document.querySelector("#editor .cm-content")!.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, PNG);
    assert(
      (await page.locator("#editor .cm-content").textContent())!
        .includes("PASTED WORDS"),
    );
    await quietFor(300); // no image is written for pasted text
    assertEquals(await imageCount(b), before);

    // A file dropped where nothing takes it (the tree) doesn't open in the
    // tab: the window's guard cancels it. The hash is left out: it follows
    // the cursor on a debounce, so it can still be catching up here.
    const address = () => page.url().split("#")[0];
    const url = address();
    const guarded = await page.evaluate((png) => {
      const dt = new DataTransfer();
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], "stray.png"));
      const fire = (type: string) =>
        document.getElementById("tree")!.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      return !fire("dragover") && !fire("drop");
    }, PNG);
    assert(guarded, "the drop on the tree is cancelled");
    assertEquals(address(), url);
  },
});

appTest({
  name: "images: the slug of an illustration completes from the book's images",
  async fn() {
    const b = await book();
    // ornament.svg is in the text already; night-sky.png isn't
    await b.write(
      "images/night-sky.png",
      Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
    );
    const page = await newPage();
    await page.goto(b.url());
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
    await (await chooser).setFiles(pngFile("Harbour.png"));
    await page.locator("#editor .cm-line", {
      hasText: "{illustration: harbour",
    }).waitFor();
    assert(await hasImage(b, "harbour.png"));
  },
});

appTest({
  name: "images: an empty placeholder takes a picked or dropped image (Write)",
  async fn() {
    const tag = "{illustration: harbour | placement: inline}";
    const b = await book({
      manuscript: (demo) =>
        `${demo}\n${tag}\nThe Harbour\n\n{illustration: pier}\n`,
    });
    const page = await newPage();
    await page.goto(b.url());
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
    await picker.setFiles(pngFile("Some Photo.png"));
    // Saved under the placeholder's slug; the rebuild (held ~1.2 s for an
    // images-only change) shows the image.
    await page.locator(`${live} figure#harbour img`).waitFor({
      timeout: 30_000,
    });
    assert(await hasImage(b, "harbour.png"));
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
    assert(await hasImage(b, "pier.png"));
  },
});
