// server/export-html.ts — a built book as one standalone page that paginates
// itself: `bml render`, and what print export hands to Chrome. Deno only: it
// inlines the vendored Paged.js and the renderer's handlers from disk.
import type { BuildResult } from "./pipeline.ts";
import type { Seed } from "../renderer/page-map-types.ts";

// Paged.js 0.4.3, vendored (see server/vendor_test.ts). Shared by toHtml and
// the browser tests so nothing loads it from a CDN.
export const PAGED_JS = await Deno.readTextFile(
  new URL("../vendor/pagedjs/paged.js", import.meta.url),
);
const PLATES_JS = await Deno.readTextFile(
  new URL("../renderer/plates.js", import.meta.url),
);
const FOLIOS_JS = await Deno.readTextFile(
  new URL("../renderer/folios.js", import.meta.url),
);

// Export driver (spec §5.4): starting from BOOK_SEED (the last export's settled
// folios, or {}), re-render until the page map's folios are the ones the
// render was seeded with, then leave the outcome on <html> for
// pdf.ts — data-paged=done|error|fatal plus a JSON report in
// data-paged-report. "error" is pagination problems (--force exports anyway;
// warnings alone are "done");
// "fatal" is the driver itself failing (e.g. Paged.js didn't load), which
// never exports.
// The book's <style> is fed to Paged.js explicitly and removed, so it isn't
// also applied unpolished; Paged.js's removeStyles is never called.
const DRIVER_JS = `document.addEventListener("DOMContentLoaded", async () => {
  const root = document.documentElement;
  const styleEl = document.getElementById("book-css");
  const css = { [location.href]: styleEl.textContent };
  styleEl.remove();
  const html = document.body.innerHTML;
  document.body.innerHTML = "";
  let previewer = null;
  let passes = 0;
  let report;
  try {
    const r = await BookPageMap.settle(async (seed) => {
      previewer?.polisher.destroy();
      document.querySelector(".pagedjs_pages")?.remove();
      passes++;
      previewer = new Paged.Previewer({ pageMap: { seed, numbering: BOOK_NUMBERING } });
      return (await previewer.preview(html, [css], document.body)).pageMapResult;
    }, BOOK_SEED);
    report = {
      problems: r.problems,
      passes: r.passes,
      digest: BookPageMap.digest(r.map),
      seed: r.seed,
    };
  } catch (err) {
    report = { fatal: String(err), passes };
  }
  root.dataset.pagedReport = JSON.stringify(report);
  root.dataset.paged = report.fatal ? "fatal" : report.problems.some((p) => !p.warn) ? "error" : "done";
});`;

/** `seed`: the page map's starting folios (default {}); print export passes the last one. */
export function toHtml(b: BuildResult, opts: { seed?: Seed } = {}): string {
  const json = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${b.bookTitle}</title>
${b.fontLinks}
<style id="book-css">${b.baseCss}\n${b.domCss}\n${b.pagedCss}</style>
<script>const BOOK_NUMBERING = ${json(b.pageNumbering)};
const BOOK_SEED = ${json(opts.seed ?? {})};</script>
<script>${PAGED_JS}</script>
<script>${PLATES_JS}</script>
<script>${FOLIOS_JS}</script>
<script>${DRIVER_JS}</script>
</head><body>${b.html}</body></html>`;
}
