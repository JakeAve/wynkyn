// server/export-html.ts — a built book as one standalone page that paginates
// itself: `bml render`, and what print export hands to Chrome. Deno only: it
// inlines the vendored Paged.js and the renderer's handlers from disk.
import type { BuildResult } from "./pipeline.ts";
import type { Seed } from "../renderer/page-map-types.ts";
import { escapeHtml } from "../renderer/render.ts";

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
// folios, or {}), lay the book out until the page map's folios are the ones
// the render was seeded with, then leave the outcome on <html> for
// pdf.ts — data-paged=done|error|fatal plus a JSON report in
// data-paged-report. "error" is pagination problems (--force exports anyway;
// warnings alone are "done");
// "fatal" is the driver itself failing (e.g. Paged.js didn't load), which
// never exports.
// With BOOK_SEGMENTS (spec: segmented layout) each segment is laid out by its
// own Previewer in an off-screen stage (moved away, never display: none:
// layout measures), then assembled into one .pagedjs_pages; settleSegments
// re-lays only the segments whose printed numbers changed. One Previewer's
// sheets stay for printing; the others' are removed, which holds because every
// segment's must be the same (else null, and the book is laid out whole).
// Without them (toHtml's `whole`), or on that fallback, the book is one flow
// with a fresh Previewer per pass. html[data-paged-layout] says which ran.
// The book's <style> is fed to Paged.js explicitly and removed, so it isn't
// also applied unpolished; Paged.js's removeStyles is never called.
const DRIVER_JS = `document.addEventListener("DOMContentLoaded", async () => {
  const root = document.documentElement;
  const styleEl = document.getElementById("book-css");
  const css = { [location.href]: styleEl.textContent };
  styleEl.remove();
  const html = document.body.innerHTML;
  document.body.innerHTML = "";
  let passes = 0;
  let report;
  const whole = async () => {
    let previewer = null;
    return await BookPageMap.settle(async (seed) => {
      previewer?.polisher.destroy();
      document.querySelector(".pagedjs_pages")?.remove();
      passes++;
      previewer = new Paged.Previewer({ pageMap: { seed, numbering: BOOK_NUMBERING } });
      return (await previewer.preview(html, [css], document.body)).pageMapResult;
    }, BOOK_SEED);
  };
  const segmented = async () => {
    const area = document.createElement("div");
    area.className = "pagedjs_pages";
    document.body.append(area);
    const stages = [];
    let kept = null;
    const layOut = async (segment, seed) => {
      const stage = document.createElement("div");
      stage.style.cssText = "position: absolute; top: 0; left: -100000px; width: 100%";
      document.body.append(stage);
      stages.push(stage);
      const previewer = new Paged.Previewer({ pageMap: { seed, numbering: BOOK_NUMBERING, segment: true } });
      const flow = await previewer.preview(segment.html, [css], stage);
      const { polisher } = previewer;
      const sheet = [...polisher.inserted, polisher.styleEl]
        .filter((el) => el !== polisher.base)
        .map((el) => [...el.sheet.cssRules].map((r) => r.cssText).join(""))
        .join("");
      if (kept) polisher.destroy();
      else kept = previewer;
      const { facts, problems } = flow.pageMapResult;
      return { segment, pages: [...flow.pagesArea.querySelectorAll(":scope > .pagedjs_page")], facts, problems, sheet };
    };
    const r = await BookPageMap.settleSegments(BOOK_SEGMENTS, layOut, (laid) => {
      const result = BookPageMap.assemble(laid, BOOK_NUMBERING, area, kept.chunker.pageTemplate);
      area.style.setProperty("--pagedjs-page-count", result.map.length);
      return result;
    }, BOOK_SEED);
    for (const stage of stages) stage.remove();
    if (!r) {
      kept?.polisher.destroy();
      area.remove();
    }
    return r;
  };
  try {
    let r = BOOK_SEGMENTS && await segmented();
    root.dataset.pagedLayout = r ? "segments" : "whole";
    r ??= await whole();
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

/** `seed`: the page map's starting folios (default {}); print export passes
 * the last one. `whole`: lay `b.html` out as one flow instead of through its
 * segments (the fallback, and the parity test's reference). */
export function toHtml(
  b: BuildResult,
  opts: { seed?: Seed; whole?: boolean } = {},
): string {
  const json = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");
  // Metadata values reach the CSS as written; `<\/` is the same text to CSS
  // and can't end the <style> element.
  const css = `${b.baseCss}\n${b.domCss}\n${b.pagedCss}`.replaceAll(
    "</",
    "<\\/",
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${
    escapeHtml(b.bookTitle)
  }</title>
${b.fontLinks}
<style id="book-css">${css}</style>
<script>const BOOK_NUMBERING = ${json(b.pageNumbering)};
const BOOK_SEED = ${json(opts.seed ?? {})};
const BOOK_SEGMENTS = ${json(opts.whole ? null : b.segments)};</script>
<script>${PAGED_JS}</script>
<script>${PLATES_JS}</script>
<script>${FOLIOS_JS}</script>
<script>${DRIVER_JS}</script>
</head><body>${b.html}</body></html>`;
}
