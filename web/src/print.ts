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
  for (const side of sides) {
    const sheet = document.createElement("div");
    // pagedjs_pages: Paged.js's own rules (split-element guards) key on it.
    sheet.className = "pagedjs_pages print-sheet";
    // !important: Paged.js's print rules size .pagedjs_pages to the page.
    sheet.style.setProperty("width", `${W}in`, "important");
    sheet.style.setProperty("height", `${H}in`, "important");
    sheet.setAttribute("aria-label", side.label);
    for (const slot of side.slots) {
      if (slot.page === null) continue;
      const src = pages[slot.page];
      if (!src) throw new Error(`the preview has no page ${slot.page + 1}`);
      const clone = src.cloneNode(true) as HTMLElement;
      clone.style.left = `${slot.x}in`; // where impose() put it, as the PDFs do
      clone.style.top = `${slot.y}in`;
      if (slot.rotate) clone.style.transform = "rotate(180deg)";
      sheet.append(clone);
    }
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
