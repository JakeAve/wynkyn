// web/src/prose-browser_test.ts — the Prose view in the real app
// (design-language.md §8.1): rubrics in the margin, markup folded until a
// click on its mark opens the block, ⁂ for a break, ☞ for a note, page
// turns from the last layout, the expanded margins and Dim.
import { assert, assertEquals } from "@std/assert";
import { appTest, book } from "../../testing/app.ts";
import { newPage } from "../../testing/chrome.ts";
import { laidOut } from "../../testing/wait.ts";

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

async function open(manuscript: string) {
  const b = await book({ manuscript });
  const page = await newPage();
  await page.goto(b.url());
  await page.locator("#editor .cm-line").first().waitFor();
  return page;
}

appTest({
  name: "Prose draws rubrics, ⁂ and ☞, and a click on a rubric opens markup",
  fn: async () => {
    const page = await open(MANUSCRIPT);
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
    assert(!text.includes("{chapter"), "the cursor alone reveals nothing");
    assert(!text.includes("{em}"));

    await chapter.click();
    text = await shown();
    assert(text.includes("{chapter: one}"), "the rubric opens the block");
    assertEquals(
      await page.evaluate(() => getSelection()?.toString()),
      "",
      "and selects nothing",
    );
    assert(text.includes("{title}"));
    assert(!text.includes("{break}"), "other blocks stay folded");

    await page.locator("#editor .cm-line", { hasText: "After the break" })
      .click();
    text = await shown();
    assert(!text.includes("{chapter"), "leaving the block folds it");

    // Inline tags have rubrics too, under the line's own; a click on
    // one opens its paragraph.
    const tags = page.locator(
      '#editor .cm-prose-rubric[data-label="Drop cap"] .cm-prose-tags',
    );
    assertEquals(await tags.getAttribute("data-tags"), "Em");
    await tags.click();
    text = await shown();
    assert(text.includes("{em}striking{/em}"), "the em rubric opens it");
  },
});

appTest({
  name: "Prose: a click that reveals markup stays a click, not a drag",
  fn: async () => {
    const page = await open(MANUSCRIPT);
    // The reveal (here of {dropcap} above) moves the rubric under the
    // pointer; a hand that drifts a pixel between press and release must
    // not select across the shift.
    const box = (await page.locator(
      '#editor .cm-prose-rubric[data-label="Drop cap"]',
    ).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 1);
    await page.mouse.up();
    // the click reveals the block
    await page.locator("#editor .cm-line", { hasText: "{dropcap}" })
      .waitFor();
    assertEquals(
      await page.evaluate(() => getSelection()?.toString()),
      "",
      "and selects nothing",
    );
  },
});

appTest({
  name: "Prose: an edit into folded markup opens it instead",
  fn: async () => {
    const page = await open(MANUSCRIPT);
    const shown = () => page.locator("#editor .cm-content").innerText();
    // A backspace at the title's start would join it to the hidden
    // {title} line; it opens the block and changes nothing.
    await page.locator("#editor .cm-line", { hasText: "Chapter One" })
      .click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    const text = await shown();
    assert(text.includes("{title}\nChapter One"), "opened, unchanged");
    // Typing in plain text, outside any markup, goes ahead.
    await page.locator("#editor .cm-line", { hasText: "After the break" })
      .click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    assert((await shown()).includes("After the break.!"));
  },
});

const LONG = `{matter: half-title}
{title}
A Long Book

{chapter: one}
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

appTest({
  name: "Prose shows page turns from the last layout",
  fn: async () => {
    const page = await open(LONG);
    const turn = page.locator('#editor .cm-prose-turn[data-turn="2"]');
    // The turns land with the whole layout, not with its second page
    // (Paged.js draws page by page).
    await laidOut(page);
    // CodeMirror draws only the lines near the viewport: scroll a step at
    // a time, each after the redraw, until the turn is drawn or the end.
    while (!await turn.count()) {
      const moved = await page.locator("#editor .cm-scroller").evaluate(
        async (s) => {
          const top = s.scrollTop;
          s.scrollTop += 200;
          for (let i = 0; i < 2; i++) {
            await new Promise((r) => requestAnimationFrame(r));
          }
          return s.scrollTop !== top;
        },
      );
      if (!moved) break;
    }
    assertEquals(await turn.getAttribute("data-long"), "p. 2");
    // The printed folio, not the count of pages: the body starts at 1
    // after the half-title.
    assertEquals(
      await page.locator("#editor .cm-line", { hasText: "Chapter One" })
        .locator(".cm-prose-turn").getAttribute("data-turn"),
      "1",
    );
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
  },
});

// The demo book has images/ornament.svg; nothing is called "lost".
const ILLUSTRATIONS = `Opening words, where the cursor starts.

{illustration: ornament}
An ornament.

{illustration: ornament}
%% a folded note between the image and its caption
Another ornament.

{illustration: lost}
Nowhere to be found.
`;

appTest({
  name: "Prose draws an illustration's image, and a missing one as markup",
  fn: async () => {
    const page = await open(ILLUSTRATIONS);
    const img = page.locator("#editor .cm-prose-illustration img");
    await img.first().waitFor();
    assert(
      (await img.first().getAttribute("src"))!.endsWith("/ornament.svg"),
      "the present file's image",
    );
    const figure = page.locator("#editor .cm-prose-illustration");
    assertEquals(
      await figure.first().locator(".cm-prose-rubric").getAttribute(
        "data-slug",
      ),
      "ornament",
    );
    assertEquals(await img.count(), 2);
    const caption = page.locator("#editor .cm-line.cm-prose-caption");
    assertEquals(await caption.allInnerTexts(), [
      "An ornament.",
      "Another ornament.",
    ]);
    // A folded note between the image and its caption: the caption's row
    // still comes straight after the image.
    assertEquals(
      await figure.nth(1).evaluate((e) => e.nextElementSibling?.textContent),
      "Another ornament.",
    );
    const shown = () => page.locator("#editor .cm-content").innerText();
    let text = await shown();
    assert(!text.includes("{illustration: ornament}"), "folded");
    assert(text.includes("{illustration: lost}"), "missing: markup");

    // A turn on the caption's line goes beside the image, since the
    // folded illustration line covers the caption's start. A layout puts
    // the turn on the illustration's own line, so the test sets one with
    // the app's own page-turn effect, caught from its dispatches.
    await page.evaluate(() => {
      type Effect = { type: unknown; value: unknown };
      // deno-lint-ignore no-explicit-any
      const g = globalThis as any;
      const view = g.document.querySelector("#editor .cm-content").cmTile
        .root.view;
      const dispatch = view.dispatch.bind(view);
      view.dispatch = (...specs: { effects?: Effect | Effect[] }[]) => {
        for (const e of specs.flatMap((s) => [s?.effects ?? []].flat())) {
          const v = e.value;
          if (Array.isArray(v) && v.length && "page" in v[0]) {
            g.turns = e.type;
          }
        }
        return dispatch(...specs);
      };
      g.setTurn = (line: number, page: string) =>
        dispatch({ effects: g.turns.of([{ line, page }]) });
    });
    await page.locator("#editor .cm-line", { hasText: "Opening words" })
      .click();
    await page.keyboard.type("x"); // a new layout, and its turns
    await page.waitForFunction(() => "turns" in globalThis, null, {
      timeout: 30_000,
    });
    await page.evaluate(() =>
      // deno-lint-ignore no-explicit-any
      (globalThis as any).setTurn(4, "7")
    );
    assertEquals(
      await figure.first().locator('.cm-prose-turn[data-turn="7"]').count(),
      1,
      "the caption's turn beside the image",
    );
    await page.evaluate(() =>
      // deno-lint-ignore no-explicit-any
      (globalThis as any).setTurn(8, "9")
    );
    assertEquals(
      await figure.nth(1).locator('.cm-prose-turn[data-turn="9"]').count(),
      1,
      "past a folded note too",
    );

    // A click on the image opens its markup; the image stays.
    await img.first().click();
    text = await shown();
    assert(text.includes("{illustration: ornament}"), "revealed");
    assertEquals(await img.count(), 2);
  },
});

appTest({
  name: "Expanded, the margins widen and notes and turns are written out",
  fn: async () => {
    const page = await open(MANUSCRIPT);
    const content = page.locator("#editor .cm-content");
    const padding = () =>
      content.evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
    const note = page.locator("#editor .cm-prose-note");
    const noteText = () =>
      note.evaluate((e) => getComputedStyle(e, "::after").content);
    const narrow = await padding();
    assertEquals(await noteText(), "none", "the ☞ alone");

    await page.locator("#editor .expand").click();
    assertEquals(
      await page.locator("#panes").getAttribute("class"),
      "expand-writing",
    );
    assert(await padding() > narrow, "the left margin widens");
    assertEquals(
      await noteText(),
      '"check: thirteen, as in the source."',
      "the note written out",
    );
    assert((await note.boundingBox())!.width > 100, "and shown");

    // The pinned outline slides in over the view; the pane's header
    // steps right of it, so Prose | Source and Aa stay reachable.
    await page.locator("#tree-toggle").click();
    // Measure once the slide and the header's step have finished, not after
    // a guess at how long they take: a slow runner lands mid-transition.
    for (const el of ["#tree", "#editor .pane-head"]) {
      await page.locator(el).evaluate((e) =>
        Promise.all(e.getAnimations().map((a) => a.finished))
      );
    }
    const tree = (await page.locator("#tree").boundingBox())!;
    const source = (await page.locator("#editor .pane-head").getByText(
      "Source",
    ).boundingBox())!;
    assert(source.x >= tree.x + tree.width, "the header clears the outline");
  },
});

appTest({
  name: "Dim fades all but the cursor's paragraph or sentence",
  fn: async () => {
    const page = await open(
      "First sentence here. Second sentence here.\n\nAnother paragraph.\n",
    );
    const line = (t: string) =>
      page.locator("#editor .cm-line", { hasText: t });
    const opacity = (t: string) =>
      page.locator("#editor .cm-text", { hasText: t }).evaluate((e) =>
        Number(getComputedStyle(e).opacity)
      );
    // Once `dimmed` marks it, the fade has run its course: read straight
    // after the class lands, the opacity is still the fade's starting 1.
    const faded = async (dimmed: string, t: string) => {
      await page.locator(dimmed, { hasText: t }).waitFor();
      await page.locator("#editor .cm-text", { hasText: t }).evaluate((e) =>
        Promise.all(e.getAnimations().map((a) => a.finished))
      );
    };
    // the Aa menu's Dim seg; a lint tooltip may cover the menu's button
    const dim = (d: string) =>
      page.locator(`[data-dim="${d}"]`).evaluate((b) =>
        (b as HTMLElement).click()
      );
    assertEquals(
      await page.locator("#editor .cm-text").count(),
      0,
      "off by default",
    );
    await dim("paragraph");
    await line("Second sentence").click();
    await faded("#editor .cm-line.cm-dim", "Another paragraph");
    assert(await opacity("Another paragraph") < 1, "another paragraph fades");
    assertEquals(await opacity("Second sentence"), 1);

    await dim("sentence");
    await line("Second sentence").click();
    await page.keyboard.press("End");
    await faded("#editor .cm-text.cm-off", "First sentence");
    assert(await opacity("First sentence") < 1, "another sentence fades");
    assertEquals(await opacity("Second sentence"), 1);
  },
});
