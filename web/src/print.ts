// web/src/print.ts — print the imposed sheets from this browser (spec §7.7).
// Clones the live preview's Paged.js pages onto sheet-sized print pages, laid
// out by the same impose() the PDF export uses, then opens the print dialog:
// a printer gets the sheets, Save as PDF gives the same file as sheets.pdf.
// Nothing runs on the server, so it needs no Chrome there. The layer and its
// @page rule go away once the dialog closes.
import type { Dims, Side } from "../../server/imposition.ts";

export interface SheetLayout {
  sheet: Dims; // inches, oriented as the grid lays it out
  page: Dims;
  cols: number;
  rows: number;
}

export function printSheets(
  pages: HTMLElement[],
  sides: Side[],
  geom: SheetLayout,
): void {
  document.getElementById("print-sheets")?.remove();
  const layer = document.createElement("div");
  layer.id = "print-sheets";
  const { w: W, h: H } = geom.sheet;
  const { w: pw, h: ph } = geom.page;
  const x0 = (W - geom.cols * pw) / 2; // centred, as buildSheetPdf lays it out
  const y0 = (H - geom.rows * ph) / 2;
  for (const side of sides) {
    const sheet = document.createElement("div");
    // pagedjs_pages: Paged.js's own rules (split-element guards) key on it.
    sheet.className = "pagedjs_pages print-sheet";
    // !important: Paged.js's print rules size .pagedjs_pages to the page.
    sheet.style.setProperty("width", `${W}in`, "important");
    sheet.style.setProperty("height", `${H}in`, "important");
    sheet.setAttribute("aria-label", side.label);
    side.slots.forEach((slot, i) => {
      if (slot.page === null) return;
      const src = pages[slot.page];
      if (!src) throw new Error(`the preview has no page ${slot.page + 1}`);
      const clone = src.cloneNode(true) as HTMLElement;
      clone.style.left = `${x0 + (i % geom.cols) * pw}in`;
      clone.style.top = `${y0 + Math.floor(i / geom.cols) * ph}in`;
      if (slot.rotate) clone.style.transform = "rotate(180deg)";
      sheet.append(clone);
    });
    layer.append(sheet);
  }
  // Last in <head>, so it outranks the trim-size @page Paged.js wrote.
  const style = document.createElement("style");
  style.textContent = `@page { size: ${W}in ${H}in; margin: 0; }`;
  document.head.append(style);
  document.body.append(layer);
  document.body.classList.add("printing");
  addEventListener("afterprint", () => {
    layer.remove();
    style.remove();
    document.body.classList.remove("printing");
  }, { once: true });
  print();
}
