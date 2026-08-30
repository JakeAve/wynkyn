// server/print-export.ts — sheet PDFs from an Imposition (spec §7.7, design §2 step 4).
import { degrees, PDFDocument, type PDFEmbeddedPage, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { Dims, Imposition, Slot } from "./imposition.ts";

const PT = 72; // points per inch

export interface SheetGeometry {
  sheet: Dims;
  page: Dims;
  nUp: number;
}

export interface Side {
  label: string; // "sig 1 · sheet 2 · back"
  slots: Slot[];
}

/** Order the sheet sides for a given output file. */
export function sidesFor(imp: Imposition, mode: "duplex" | "fronts" | "backs", reverseBacks: boolean): Side[] {
  const sides: Side[] = [];
  imp.sheets.forEach((sh, i) => {
    const n = (i % imp.sheetsPerSignature) + 1;
    const label = (face: string) => `sig ${sh.signature + 1} · sheet ${n} · ${face}`;
    if (mode !== "backs") sides.push({ label: label("front"), slots: sh.front });
    if (mode !== "fronts") sides.push({ label: label("back"), slots: sh.back });
  });
  return mode === "backs" && reverseBacks ? sides.reverse() : sides;
}

/**
 * One landscape PDF page per side. `source` is the trim-size book PDF whose
 * pages get embedded; null draws numbered proof placeholders instead.
 */
export async function buildSheetPdf(sides: Side[], geom: SheetGeometry, source: Uint8Array | null): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const W = Math.max(geom.sheet.w, geom.sheet.h) * PT;
  const H = Math.min(geom.sheet.w, geom.sheet.h) * PT;
  const pw = geom.page.w * PT;
  const ph = geom.page.h * PT;
  const x0 = (W - geom.nUp * pw) / 2; // row of pages centred on the sheet
  const y0 = (H - ph) / 2;

  let embedded: PDFEmbeddedPage[] = [];
  if (source) {
    const src = await PDFDocument.load(source);
    embedded = await out.embedPdf(src, src.getPageIndices());
  }

  const drawSlot = (page: PDFPage, slot: Slot, i: number, label: string) => {
    const x = x0 + i * pw;
    const y = y0;
    // pdf-lib rotates about (x, y); a 180° turn needs the opposite corner as origin.
    const at = slot.rotate === 180 ? { x: x + pw, y: y + ph, rotate: degrees(180) } : { x, y, rotate: degrees(0) };
    if (slot.page === null) return;
    if (source) {
      const emb = embedded[slot.page];
      if (!emb) throw new Error(`book.pdf has no page ${slot.page + 1}`);
      page.drawPage(emb, { ...at, width: pw, height: ph });
      return;
    }
    // Proof placeholder: border, big page number, and where this slot sits.
    page.drawRectangle({ x, y, width: pw, height: ph, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
    const num = String(slot.page + 1);
    const size = 72;
    page.drawText(num, { x: x + pw / 2 - font.widthOfTextAtSize(num, size) / 2, y: y + ph / 2 - size / 3, size, font, ...(slot.rotate === 180 ? { rotate: degrees(180), x: x + pw / 2 + font.widthOfTextAtSize(num, size) / 2, y: y + ph / 2 + size / 3 } : {}) });
    page.drawText(`${label} · folio ${slot.folio}`, { x: x + 8, y: y + 8, size: 8, font });
  };

  for (const side of sides) {
    const page = out.addPage([W, H]);
    side.slots.forEach((slot, i) => drawSlot(page, slot, i, side.label));
  }
  return await out.save();
}
