import { assert, assertEquals } from "jsr:@std/assert";
import { PDFDocument } from "pdf-lib";
import { renderPdf } from "./pdf.ts";
import { buildBook, toHtml } from "./pipeline.ts";

const ROOT = new URL("./testdata", import.meta.url).pathname;
const hasChrome = await Deno.stat("/Applications/Google Chrome.app").then(() => true, () => false);

Deno.test({ name: "renderPdf paginates the demo book at trim size", ignore: !hasChrome, fn: async () => {
  const html = toHtml(await buildBook(ROOT, "demo-book"));
  assert(html.includes("PagedConfig"), "toHtml must signal when Paged.js finishes");
  const doc = await PDFDocument.load(await renderPdf(html));
  assert(doc.getPageCount() >= 2);
  const { width, height } = doc.getPage(0).getSize();
  assertEquals(Math.round(width), Math.round(5.5 * 72)); // demo-book page.size is 5.5in 8.5in
  assert(height > width);
} });
