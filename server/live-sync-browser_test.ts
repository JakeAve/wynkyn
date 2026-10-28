// server/live-sync-browser_test.ts — the live-sync loop (spec §6) in the real
// app: a change on disk under a clean buffer, under a dirty one (the
// changed-on-disk banner), and the editor's own save.
import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "./dev-server.ts";
import { hasChrome } from "../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../web/app.js", import.meta.url))
  .then(() => true, () => false);

// Polls a Deno-side condition; the client's save debounce is fixed in app.ts.
async function until(
  what: string,
  ok: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The buffer, read from the rendered lines: CodeMirror's view object hangs
// off internal DOM properties that change between versions, while
// `.cm-line` per document line is stable. The fixture is short enough that
// every line is in the viewport, and it has no {only} spans, so no widget
// text gets mixed in.
const buffer = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#editor .cm-content .cm-line")]
      .map((l) => l.textContent).join("\n")
  );

// The caret as [line index, column], from the DOM selection, which
// CodeMirror keeps in sync with its own while the editor has focus.
const caret = (page: Page) =>
  page.evaluate(() => {
    const sel = getSelection()!;
    const line = sel.focusNode?.parentElement?.closest(".cm-line");
    if (!line) return null;
    const r = document.createRange();
    r.setStart(line, 0);
    r.setEnd(sel.focusNode!, sel.focusOffset);
    const lines = [...document.querySelectorAll("#editor .cm-line")];
    return [lines.indexOf(line), r.toString().length];
  });

const bannerShown = (page: Page) => page.locator("#disk-banner").isVisible();

Deno.test({
  name: "live sync: disk changes reach the editor, conflicts get the banner, " +
    "own saves land quietly",
  ignore: !hasChrome || !appBuilt,
  async fn(t) {
    const root = await Deno.makeTempDir();
    const file = `${root}/demo-book/manuscript.md`;
    // The way most editors save, and the server's own write: never half a file.
    const writeDisk = async (text: string) => {
      await Deno.writeTextFile(`${file}.tmp`, text);
      await Deno.rename(`${file}.tmp`, file);
    };
    const disk = () => Deno.readTextFile(file);
    const src = new URL("./testdata/demo-book", import.meta.url).pathname;
    const cp = await new Deno.Command("cp", {
      args: ["-R", src, `${root}/demo-book`],
    }).output();
    assert(cp.success, "copy the fixture book");
    const server = await startServer({
      booksRoot: root,
      port: 0,
    });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      let updates = 0; // build pushes over the socket
      page.on("websocket", (ws) =>
        ws.on("framereceived", ({ payload }) => {
          if (String(payload).startsWith('{"type":"update"')) updates++;
        }));
      // Source: every line as typed, so the DOM reads back as the buffer
      // (Prose folds markup away).
      await page.addInitScript(() =>
        localStorage.setItem("text-view", '{"view":"source"}')
      );
      await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
      await page.locator('#status[data-kind="saved"]').waitFor();
      const original = await disk();
      assertEquals(await buffer(page), original);
      const edit = page.locator("#editor .cm-content");

      await t.step("a disk change under a clean buffer loads", async () => {
        const next = original.replace("Demo Book", "Demo Book (a)");
        await writeDisk(next);
        await until(
          "the buffer to load it",
          async () => await buffer(page) === next,
        );
        assert(!await bannerShown(page));
      });

      // Typing, then writing the file at once: the disk change lands long
      // before the client's 600ms save debounce, so the editor is dirty when
      // the update arrives (banner), and its save, based on the old version,
      // gets a 409 (banner) either way.
      const conflict = async (typed: string, onDisk: string) => {
        await edit.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(typed);
        const before = await disk();
        await writeDisk(before.replace(/Demo Book.*/, onDisk));
        await page.locator("#disk-banner").waitFor();
      };

      await t.step("a conflict, then Reload: the disk wins", async () => {
        await conflict(" typed", "Demo Book (b)");
        await page.locator("#disk-reload").click();
        const now = await disk();
        assert(now.includes("Demo Book (b)") && !now.includes(" typed"));
        assertEquals(await buffer(page), now);
        assert(!await bannerShown(page));
        await page.locator('#status[data-kind="saved"]').waitFor();
      });

      await t.step("a conflict, then Keep mine: the buffer wins", async () => {
        await conflict(" mine", "Demo Book (c)");
        await page.locator("#disk-keep").click();
        await until(
          "the save to land",
          async () => await disk() === await buffer(page),
        );
        const now = await disk();
        assert(now.includes(" mine") && !now.includes("Demo Book (c)"));
        assert(!await bannerShown(page));
        await page.locator('#status[data-kind="saved"]').waitFor();
      });

      await t.step("an own save lands without moving the cursor", async () => {
        // Mid-buffer, so a reload of our own text would show as a jump.
        await page.locator(".cm-line", { hasText: "Demo Book (b)" }).click();
        await page.keyboard.press("End");
        await page.keyboard.type(" own");
        const typed = await buffer(page);
        const at = await caret(page);
        assertEquals(at, [5, "Demo Book (b) own".length]);
        const seen = updates;
        await until("the save to land", async () => await disk() === typed);
        // The watcher's update for our own write is the echo to ignore.
        await until("its update to arrive", () => updates > seen);
        await page.locator('#status[data-kind="saved"]').waitFor();
        assertEquals(await buffer(page), typed);
        assertEquals(await caret(page), at);
        assert(!await bannerShown(page));
      });
    } finally {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
