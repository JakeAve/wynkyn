import { assert, assertEquals, assertRejects } from "@std/assert";
import { PDFDocument } from "pdf-lib";
import { renderPdf } from "./pdf.ts";
import { buildBook, toHtml } from "./pipeline.ts";

const ROOT = new URL("./testdata", import.meta.url).pathname;
const hasChrome = await Deno.stat("/Applications/Google Chrome.app").then(
  () => true,
  () => false,
);

Deno.test({
  name: "renderPdf paginates the demo book at trim size",
  ignore: !hasChrome,
  fn: async () => {
    const html = toHtml(await buildBook(ROOT, "demo-book"));
    const { pdf, problems, passes } = await renderPdf(html);
    assertEquals(problems, []);
    assert(passes === 1 || passes === 2, `settled in ${passes} passes`);
    const doc = await PDFDocument.load(pdf);
    assert(doc.getPageCount() >= 2);
    const { width, height } = doc.getPage(0).getSize();
    assertEquals(Math.round(width), Math.round(5.5 * 72)); // demo-book page.size is 5.5in 8.5in
    assert(height > width);
  },
});

Deno.test({
  name: "renderPdf throws a driver failure instead of reporting a problem",
  ignore: !hasChrome,
  fn: async () => {
    // What the toHtml driver leaves when e.g. Paged.js failed to load.
    const html = `<!doctype html><script>
      const r = document.documentElement;
      r.dataset.pagedReport = JSON.stringify({
        fatal: "ReferenceError: Paged is not defined",
        passes: 1,
      });
      r.dataset.paged = "fatal";
    </script>`;
    await assertRejects(
      () => renderPdf(html),
      Error,
      "Paged.js render failed: ReferenceError: Paged is not defined",
    );
  },
});
