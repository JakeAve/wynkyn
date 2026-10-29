// web/src/inspect-browser_test.ts — Inspect in the real app: at 200% the pin
// ring sits on its paragraph, the drawer's reasons are right on a real render
// (a chapter opening, a paragraph split across pages, the opener's dropped
// running head), and none of it reaches the print sheets or prints.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";
import { laidOut } from "../../testing/wait.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

const LIVE = "#preview > :not(.preview-stage) .pagedjs_page";
// The long paragraph (manuscript line 20) runs from page 3 over pages 4–5.
const LONG = 'p[data-line="20"]';

// The fixture book, plus running heads, a paragraph long enough to split
// across pages, and a second chapter: pages 3 and 6 open chapters.
async function withBook(fn: (page: Page) => Promise<void>) {
  const root = await Deno.makeTempDir();
  const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
  const cp = await new Deno.Command("cp", {
    args: ["-R", fixture.pathname, root],
  }).output();
  assert(cp.success, "copy the fixture book");
  const dir = `${root}/demo-book`;
  const meta = JSON.parse(await Deno.readTextFile(`${dir}/metadata.json`));
  meta.running = {
    odd: [{ content: "book-title", area: "top-right" }],
    even: [{ content: "chapter-title", area: "top-left" }],
  };
  await Deno.writeTextFile(`${dir}/metadata.json`, JSON.stringify(meta));
  const long = "The hallway smelt of boiled cabbage and old rag mats. ".repeat(
    60,
  );
  await Deno.writeTextFile(
    `${dir}/manuscript.md`,
    (await Deno.readTextFile(`${dir}/manuscript.md`)) +
      `\n${long}\n\n{chapter: two}\n{title}\nChapter Two\n\nShort.\n`,
  );
  const server = await startServer({ booksRoot: root, port: 0 });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
    await laidOut(page);
    await fn(page);
  } finally {
    await browser.close();
    await server.stop();
  }
}

// The overlay redraws once a frame; two frames and it has caught up.
const frames = (page: Page) =>
  page.evaluate(() =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );

const why = async (page: Page) =>
  (await page.locator("#inspect-drawer .why").innerText()).replace(
    /\s+/g,
    " ",
  );

Deno.test({
  name: "inspect: at 200% the pin ring lands on the paragraph",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withBook(async (page) => {
      for (let i = 0; i < 10; i++) {
        await page.getByRole("button", { name: "Zoom in" }).click();
      }
      assertEquals(
        await page.locator('#zoom [data-zoom="menu"]').innerText(),
        "200%",
      );
      await page.locator("#inspect").click();
      const para = page.locator(LIVE).nth(3).locator(LONG);
      await para.click();
      await page.locator("#inspect-overlay .ring.pin").waitFor();
      await frames(page);
      const [ring, target] = await page.evaluate((sel) => {
        const box = (el: Element | null) => {
          const r = el!.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height];
        };
        return [
          box(document.querySelector("#inspect-overlay .ring.pin")),
          box(document.querySelectorAll(sel.live)[3]!.querySelector(sel.p)),
        ];
      }, { live: LIVE, p: LONG });
      // The ring is an outline, drawn outside the mark's box: none to undo.
      ring.forEach((v, i) =>
        assert(Math.abs(v - target[i]!) <= 1, `ring ${ring} on ${target}`)
      );
    }),
});

Deno.test({
  name: "inspect: an opening, a split paragraph and a dropped head explain",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withBook(async (page) => {
      await page.locator("#inspect").click();
      const pages = page.locator(LIVE);
      // Chapter one opens on a right-hand page, chapter two on the next.
      await pages.nth(2).locator(".title").click();
      assert((await why(page)).includes("Starts on a right-hand page"));
      await pages.nth(5).locator(".title").click();
      assert((await why(page)).includes("Starts a new page"));
      await pages.nth(2).locator(LONG).click();
      assert((await why(page)).includes("Continues on page 2"));

      // Page 3 opens a chapter: its running head is a ghost, pinned by a
      // click on it. Its top in the pane, not under the pages header.
      await pages.nth(2).evaluate((el) => el.scrollIntoView());
      await frames(page);
      const ghost = await page.evaluate((live) => {
        const p = document.querySelectorAll(live)[2]!.getBoundingClientRect();
        const g = [...document.querySelectorAll("#inspect-overlay .ghost")]
          .map((el) => el.getBoundingClientRect())
          .find((r) => r.top < p.top + p.height / 4 && r.left >= p.left);
        return g && { x: g.left + g.width / 2, y: g.top + g.height / 2 };
      }, LIVE);
      assert(ghost, "the opener's running head shows as a ghost");
      await page.mouse.click(ghost.x, ghost.y);
      assert(
        (await why(page)).includes("Not printed: this page opens a chapter"),
        await why(page),
      );
    }),
});

Deno.test({
  name: "inspect: nothing of it reaches the print sheets or prints",
  ignore: !hasChrome || !appBuilt,
  fn: () =>
    withBook(async (page) => {
      await page.locator("#inspect").click();
      await page.locator(LIVE).nth(2).locator(LONG).click();
      // ⌥ over the chapter's title: the distances to the pinned paragraph.
      const title = await page.locator(LIVE).nth(2).locator(".title")
        .boundingBox();
      assert(title);
      await page.keyboard.down("Alt");
      await page.mouse.move(title.x + 4, title.y + title.height / 2);
      await page.locator("#inspect-overlay .pill").first().waitFor();
      // Read the marks before letting go: the keyup redraws without the pills
      // on the next frame, which a slow runner reaches before the evaluate.
      const marks = await page.evaluate(() => [
        ...new Set(
          [...document.querySelectorAll("#inspect-overlay *")].flatMap((
            el,
          ) => [...el.classList]),
        ),
      ]);
      await page.keyboard.up("Alt");
      assert(marks.includes("ring") && marks.includes("pill"), `${marks}`);

      // Printing the app itself: the button, layer and drawer are screen-only.
      const shown = () =>
        page.evaluate(() =>
          ["#inspect", "#inspect-overlay", "#inspect-drawer"].map((s) =>
            getComputedStyle(document.querySelector(s)!).display
          )
        );
      assert(!(await shown()).includes("none"), "all on screen");
      await page.emulateMedia({ media: "print" });
      assertEquals(await shown(), ["none", "none", "none"]);
      await page.emulateMedia({ media: "screen" });

      // Print sheets clones the live pages: no mark, layer or class comes too.
      await page.evaluate(() => {
        globalThis.print = () =>
          document.documentElement.setAttribute("data-printed", "");
      });
      await page.locator('#modes [data-mode="publish"]').click();
      await page.getByRole("button", { name: "Print sheets" }).click();
      await page.locator("html[data-printed]").waitFor();
      const leaked = await page.evaluate((classes) => {
        const sheets = document.getElementById("print-sheets")!;
        return {
          pages: sheets.querySelectorAll(".pagedjs_page").length,
          layers: sheets.querySelectorAll(
            "#inspect-overlay, #inspect-drawer, [data-inspect]",
          ).length,
          classes: classes.filter((c) => sheets.querySelector(`.${c}`)),
        };
      }, marks);
      assertNotEquals(leaked.pages, 0);
      assertEquals(leaked.layers, 0);
      assertEquals(leaked.classes, []);
    }),
});
