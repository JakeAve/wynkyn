// web/src/publish-browser_test.ts — the Publish view's Folios each stepper in
// the real app: a plain count saves as one (never "5pt"), and on a true fold it
// steps by whole folded sheets.
import { assertEquals } from "@std/assert";
import { appTest, book } from "../../testing/app.ts";
import { newPage } from "../../testing/chrome.ts";
import { until } from "../../testing/wait.ts";

appTest({
  name: "publish: Folios each saves a count, by whole sheets on a quarto",
  async fn() {
    // A page that folds as a folio or a quarto of legal; folio to start.
    const b = await book({
      metadata: (meta) => {
        meta.page = {
          ...meta.page,
          size: "4.25in 7in",
          sheet: "legal",
          fold: "folio",
        };
      },
    });
    const saved = async () =>
      JSON.parse((await b.read("metadata.json"))!)
        .page["folios-per-signature"];
    // Saves are debounced in the page, so wait for the file to catch up.
    const saves = (want: number) =>
      until(async () => await saved() === want, `a save of ${want}`);
    const page = await newPage();
    await page.goto(b.url("&mode=publish"));
    const input = page.getByLabel("Folios per signature", { exact: true });
    const more = page.getByLabel("Increase Folios per signature");
    const less = page.getByLabel("Decrease Folios per signature");
    await input.waitFor();
    assertEquals(await input.inputValue(), "4");

    await more.click(); // a folio: one sheet a folio, so 4 → 5
    assertEquals(await input.inputValue(), "5");
    await saves(5);

    await input.fill("7"); // typed, too
    await input.press("Enter");
    await saves(7);

    // A quarto's sheet is two folios: presses land on even counts.
    await page.getByLabel("Fold", { exact: true }).selectOption("quarto");
    await more.click();
    assertEquals(await input.inputValue(), "8");
    await less.click();
    await less.click();
    assertEquals(await input.inputValue(), "4");
    await saves(4);
  },
});
