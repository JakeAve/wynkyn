// web/src/prose-browser_test.ts — the Prose view in the real app
// (design-language.md §8.1): rubrics in the margin, markup folded outside the
// cursor's block and revealed at it, ⁂ for a break, ☞ for a note, and page
// turns from the last layout.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { startServer } from "../../server/dev-server.ts";
import { hasChrome } from "../../testing/chrome.ts";

const appBuilt = await Deno.stat(new URL("../app.js", import.meta.url))
  .then(() => true, () => false);

const MANUSCRIPT = `Opening words, where the cursor starts.

{chapter: one}
{title}
Chapter One

{dropcap}
It was a bright cold day in April, and the clocks were {em}striking{/em} thirteen.
%% check: thirteen, as in the source.

{break}

After the break.
`;

// The demo book with `manuscript` written in; the server, a page on it, and
// a cleanup.
async function open(manuscript: string) {
  const root = await Deno.makeTempDir();
  const fixture = new URL("../../server/testdata/demo-book", import.meta.url);
  const cp = await new Deno.Command("cp", {
    args: ["-R", fixture.pathname, root],
  }).output();
  assert(cp.success, "copy the fixture book");
  await Deno.writeTextFile(`${root}/demo-book/manuscript.md`, manuscript);
  const server = await startServer({ booksRoot: root, port: 0 });
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.port}/app/?book=demo-book`);
  await page.locator("#editor .cm-line").first().waitFor();
  return {
    page,
    close: async () => {
      await browser.close();
      await server.stop();
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test({
  name: "Prose draws rubrics, ⁂ and ☞, and reveals markup at the cursor",
  ignore: !hasChrome || !appBuilt,
  fn: async () => {
    const { page, close } = await open(MANUSCRIPT);
    try {
      assertEquals(
        await page.locator("#editor").getAttribute("data-view"),
        "prose",
      );
      const shown = () => page.locator("#editor .cm-content").innerText();

      const chapter = page.locator(
        '#editor .cm-prose-rubric[data-label="Chapter"]',
      );
      assertEquals(await chapter.count(), 1);
      let text = await shown();
      assert(!text.includes("{chapter"), "the chapter line is folded");
      assert(!text.includes("{em}"), "em tags are folded");
      assert(text.includes("⁂"), "a break is ⁂");
      assertEquals(await page.locator("#editor .cm-prose-note").count(), 1);
      assertEquals(
        await page.locator("#editor .cm-prose-note").getAttribute("title"),
        "check: thirteen, as in the source.",
      );

      await page.locator("#editor .cm-line", { hasText: "Chapter One" })
        .click();
      text = await shown();
      assert(text.includes("{chapter: one}"), "the cursor reveals the block");
      assert(text.includes("{title}"));
      assert(!text.includes("{break}"), "other blocks stay folded");
    } finally {
      await close();
    }
  },
});

const LONG = `{chapter: one}
{title}
Chapter One

${
  Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i + 1}. ` +
      "The quick brown fox jumps over the lazy dog, and again. ".repeat(6),
  ).join("\n\n")
}
`;

Deno.test({
  name: "Prose shows page turns from the last layout",
  ignore: !hasChrome || !appBuilt,
  fn: async () => {
    const { page, close } = await open(LONG);
    try {
      const turn = page.locator('#editor .cm-prose-turn[data-turn="2"]');
      await page.locator("#preview .pagedjs_page").nth(1).waitFor({
        timeout: 30_000,
      });
      // CodeMirror draws only the lines near the viewport: scroll to it.
      for (let i = 0; i < 40 && !await turn.count(); i++) {
        await page.locator("#editor .cm-scroller").evaluate((s) =>
          s.scrollTop += 200
        );
        await page.waitForTimeout(50);
      }
      assertEquals(await turn.getAttribute("data-long"), "p. 2");
      const line = page.locator("#editor .cm-line", {
        has: page.locator('.cm-prose-turn[data-turn="2"]'),
      });

      // An edit in that block hides its turn until the next layout lands.
      await line.click({ position: { x: 40, y: 8 } });
      await page.keyboard.type("x");
      assertEquals(await turn.count(), 0, "edited: the turn is hidden");
      await turn.waitFor({ timeout: 30_000 });

      // Page turns off in the Aa menu hides them all.
      await page.locator("#tv-aa").click();
      await page.locator("#tv-turns").click();
      assertEquals(
        await page.locator("#editor .cm-prose-turn:visible").count(),
        0,
      );
    } finally {
      await close();
    }
  },
});

// The demo book has images/ornament.svg; nothing is called "lost".
const ILLUSTRATIONS = `Opening words, where the cursor starts.

{illustration: ornament}
An ornament.

{illustration: lost}
Nowhere to be found.
`;

Deno.test({
  name: "Prose draws an illustration's image, and a missing one as markup",
  ignore: !hasChrome || !appBuilt,
  fn: async () => {
    const { page, close } = await open(ILLUSTRATIONS);
    try {
      const img = page.locator("#editor .cm-prose-illustration img");
      await img.waitFor();
      assertEquals(await img.count(), 1);
      assert(
        (await img.getAttribute("src"))!.endsWith("/ornament.svg"),
        "the present file's image",
      );
      const figure = page.locator("#editor .cm-prose-illustration");
      assertEquals(
        await figure.locator(".cm-prose-rubric").getAttribute("data-slug"),
        "ornament",
      );
      const caption = page.locator("#editor .cm-line.cm-prose-caption");
      assertEquals(await caption.innerText(), "An ornament.");
      const shown = () => page.locator("#editor .cm-content").innerText();
      let text = await shown();
      assert(!text.includes("{illustration: ornament}"), "folded");
      assert(text.includes("{illustration: lost}"), "missing: markup");

      // A click on the image reveals its markup; the image stays.
      await img.click();
      text = await shown();
      assert(text.includes("{illustration: ornament}"), "revealed");
      assertEquals(await img.count(), 1);
    } finally {
      await close();
    }
  },
});
