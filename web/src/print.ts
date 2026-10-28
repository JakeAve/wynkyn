// web/src/print.ts — print the imposed sheets from this browser (spec §7.7).
// Clones the live preview's Paged.js pages onto sheet-sized print pages, laid
// out by the same impose() the PDF export uses, then opens the print dialog:
// a printer gets the sheets, Save as PDF gives the same file as sheets.pdf.
// Nothing runs on the server, so it needs no Chrome there. The layer and its
// @page rule go away once the dialog closes.
import type { Dims, Side } from "../../server/imposition.ts";
import { MARK_STYLE, type SideMarks } from "../../server/marks.ts";

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
  // The pages' sheets are scoped to their render (preview.ts); the clones
  // sit in that scope too.
  const scope = pages[0]?.closest<HTMLElement>("[data-scope]")?.dataset.scope;
  if (scope) layer.dataset.scope = scope;
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
    const marks = marksSvg(side.marks, W, H);
    if (marks) sheet.append(marks); // after the clones, so it paints on top
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

const SVG = "http://www.w3.org/2000/svg";

// One SVG over the sheet, in inches (viewBox) so the geometry is used as-is;
// MARK_STYLE's points become inches (÷ 72). Null when the side has no marks.
function marksSvg(m: SideMarks, W: number, H: number): SVGSVGElement | null {
  if (!m.dots.length && !m.lines.length) return null;
  const pt = (n: number) => String(n / 72);
  const grey = `rgb(${MARK_STYLE.grey * 100}%,${MARK_STYLE.grey * 100}%,${
    MARK_STYLE.grey * 100
  }%)`;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "print-marks");
  svg.setAttribute("width", `${W}in`);
  svg.setAttribute("height", `${H}in`);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  for (const l of m.lines) {
    add("line", {
      x1: String(l.x1),
      y1: String(l.y1),
      x2: String(l.x2),
      y2: String(l.y2),
      stroke: grey,
      "stroke-width": pt(MARK_STYLE.line),
      ...(l.kind === "fold"
        ? { "stroke-dasharray": MARK_STYLE.dash.map(pt).join(" ") }
        : {}),
    });
  }
  for (const d of m.dots) {
    add("circle", {
      cx: String(d.x),
      cy: String(d.y),
      r: pt(MARK_STYLE.dot / 2),
      fill: grey,
    });
  }
  return svg;
}
