// server/segments-browser_test.ts — the export laid out through segments and
// assembled (spec: segmented layout) is the whole-flow render, page for page:
// what the page-map digest can't see (each page's classes, number, folio, the
// margin boxes it shows, its text). Re-run on a Paged.js upgrade. Logs both
// modes' cold-render times (spec risk 3).
import { assertEquals } from "@std/assert";
import { type Browser, chromium } from "playwright";
import { buildBook } from "./pipeline.ts";
import { toHtml } from "./export-html.ts";
import type { Metadata } from "../metadata/types.ts";
import { hasChrome } from "../testing/chrome.ts";

const ROOT = new URL("../testdata/", import.meta.url).pathname;

interface PageShape {
  classes: string;
  id: string;
  number: string;
  folio: string;
  boxes: string;
  text: string;
}

// Inline `grid-template-columns` on margin rows is left out: assembly redoes
// it on pages that changed side and doesn't always write what Paged.js
// measured (25 of Gatsby's pages), but base.css's `!important` row templates
// override both, so the printed page is the same.
async function layOut(
  browser: Browser,
  html: string,
): Promise<{ layout: string; ms: number; pages: PageShape[] }> {
  const file = await Deno.makeTempFile({ suffix: ".html" });
  const page = await browser.newPage();
  try {
    await Deno.writeTextFile(file, html);
    const start = performance.now();
    await page.goto(`file://${file}`);
    await page.waitForSelector("html[data-paged]", { timeout: 540_000 });
    const ms = Math.round(performance.now() - start);
    const paged = await page.getAttribute("html", "data-paged");
    assertEquals(
      paged,
      "done",
      `${await page.getAttribute("html", "data-paged-report")}`,
    );
    const layout = (await page.getAttribute("html", "data-paged-layout"))!;
    const pages = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".pagedjs_page")].map((p) => ({
        classes: [...p.classList].sort().join(" "),
        id: p.id,
        number: p.dataset.pageNumber ?? "",
        folio: p.dataset.folio ?? "",
        boxes: [...p.querySelectorAll(".pagedjs_margin.hasContent")]
          .map((b) =>
            [...b.classList].find((c) => c.startsWith("pagedjs_margin-"))
          ).join(" "),
        text: p.querySelector(".pagedjs_area")?.textContent ?? "",
      }))
    );
    return { layout, ms, pages };
  } finally {
    await page.close();
    await Deno.remove(file).catch(() => {});
  }
}

async function assertParity(root: string, book: string): Promise<void> {
  const built = await buildBook(root, book, {
    imageUrlPrefix: `file://${root}${book}/images`,
  });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const whole = await layOut(browser, toHtml(built, { whole: true }));
    const segmented = await layOut(browser, toHtml(built));
    console.log(
      `${book}: cold render, whole flow ${whole.ms} ms, ` +
        `${built.segments.length} segments ${segmented.ms} ms`,
    );
    assertEquals(whole.layout, "whole");
    assertEquals(segmented.layout, "segments", "fell back to the whole flow");
    assertEquals(segmented.pages.length, whole.pages.length, "page count");
    whole.pages.forEach((w, i) =>
      assertEquals(segmented.pages[i], w, `${book}: page ${i + 1}`)
    );
  } finally {
    await browser.close();
  }
}

for (const book of ["common-sense", "great-gatsby"]) {
  Deno.test({
    name: `segments: ${book} assembles to the whole-flow render`,
    ignore: !hasChrome,
    fn: () => assertParity(ROOT, book),
  });
}

// A chapter in a part is laid out inside a `.part` wrapper marked
// data-split-from (renderer/render.ts), standing in for the part's continued
// fragment in one flow: styles on the part and on its chapters (`.part >
// .chapter`), and Paged.js's resets for split fragments (margin/padding-top,
// text-indent), must reach it the same. The drop cap opening each part's
// first chapter is the likeliest to differ.
Deno.test({
  name: "segments: a part with styled chapters and drop caps",
  ignore: !hasChrome,
  fn: async () => {
    const book = "common-sense";
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/${book}`);
      await Deno.copyFile(
        `${ROOT}${book}/manuscript.md`,
        `${root}/${book}/manuscript.md`,
      );
      const meta: Metadata = JSON.parse(
        await Deno.readTextFile(`${ROOT}${book}/metadata.json`),
      );
      meta.elements = {
        ...meta.elements,
        part: {
          ...meta.elements?.part,
          "margin-top": "18pt",
          "padding-top": "12pt",
          "text-indent": "3em",
          chapter: {
            "margin-top": "24pt",
            "padding-top": "6pt",
            "text-indent": "1em",
            dropcap: { "font-size": "4.2em", color: "#8b1a1a" },
          },
        },
      };
      await Deno.writeTextFile(
        `${root}/${book}/metadata.json`,
        JSON.stringify(meta),
      );
      await assertParity(`${root}/`, book);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
