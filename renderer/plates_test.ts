import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { pageNumberingConfig } from "../metadata/css-generator.ts";
import { parse } from "../parser/parser.ts";
import { PAGED_JS, toHtml } from "../server/export-html.ts";
import { hasChrome } from "../testing/chrome.ts";

const para = (n: number) =>
  `<p>${
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12)
  }${n}</p>`;
const body = `<article class="bml">${para(1)}${
  para(2)
}<figure class="illustration placement-full-page"><div class="illustration-placeholder">plate</div></figure>${
  [3, 4, 5, 6, 7, 8].map(para).join("")
}</article>`;
const baseCss = await Deno.readTextFile(new URL("./base.css", import.meta.url));
const platesJs = await Deno.readTextFile(
  new URL("./plates.js", import.meta.url),
);
const pagedCss = "@page { size: 4in 6in; margin: 0.5in; }";

async function withChrome(fn: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    await fn(await browser.newPage());
  } finally {
    await browser.close();
  }
}

// The plate is alone on its page, text on either side, and the page before
// it is full: less than a line of empty space under its last line.
async function assertPlate(page: Page) {
  const pages = await page.$$eval(".pagedjs_page", (els) =>
    els.map((p) => {
      const area = p.querySelector(".pagedjs_page_content")!;
      // Measure a text node: Paged.js's wrapper div is always page-tall.
      const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.textContent!.trim()) last = n;
      }
      const r = document.createRange();
      if (last) r.selectNodeContents(last);
      return {
        plate: p.classList.contains("pagedjs_display_page"),
        text: area.textContent!.trim(),
        gap: area.getBoundingClientRect().bottom -
          r.getBoundingClientRect().bottom,
      };
    }));
  const i = pages.findIndex((p) => p.plate);
  assert(i > 0 && i < pages.length - 1, `plate at ${i} of ${pages.length}`);
  assertEquals(pages[i]!.text, "plate");
  assert(
    pages[i - 1]!.gap < 30,
    `page before the plate is short by ${pages[i - 1]!.gap}px`,
  );
  assertEquals(pages.filter((p) => p.plate).length, 1);
}

Deno.test({
  name: "plates: toHtml (render, export) fills the page, then the plate",
  ignore: !hasChrome,
  fn: () =>
    withChrome(async (page) => {
      await page.setContent(toHtml({
        book: "t",
        edition: null,
        bookTitle: "T",
        doc: parse(""),
        fontLinks: "",
        diagnostics: [],
        html: body,
        segments: [],
        imageUrls: {},
        baseCss,
        domCss: "",
        domRules: [],
        pagedCss,
        pageNumbering: pageNumberingConfig({}),
        manuscriptVersion: "",
        metadataVersion: null,
      }));
      await page.waitForSelector("html[data-paged=done]", { timeout: 60_000 });
      await assertPlate(page);
    }),
});

Deno.test({
  name:
    "plates: Previewer.preview(htmlString), as the web preview calls it, fills the page, then the plate",
  ignore: !hasChrome,
  fn: () =>
    withChrome(async (page) => {
      await page.setContent(
        `<!doctype html><script>${PAGED_JS}</script><script>${platesJs}</script><div id="out"></div>`,
      );
      await page.evaluate(`(async () => {
        const css = URL.createObjectURL(new Blob([${
        JSON.stringify(baseCss + pagedCss)
      }], { type: "text/css" }));
        await new Paged.Previewer().preview(${
        JSON.stringify(body)
      }, [css], document.getElementById("out"));
      })()`);
      await assertPlate(page);
    }),
});
