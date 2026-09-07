// server/print-export.ts — sheet PDFs from an Imposition (spec §7.7, design §2 step 4).
import {
  degrees,
  PDFDocument,
  type PDFEmbeddedPage,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";
import {
  type Dims,
  type Flip,
  impose,
  type Imposition,
  parseDims,
  type Slot,
} from "./imposition.ts";
import { loadMetadata } from "../metadata/loader.ts";
import { buildBook, toHtml } from "./pipeline.ts";
import { renderPdf } from "./pdf.ts";

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
export function sidesFor(
  imp: Imposition,
  mode: "duplex" | "fronts" | "backs",
  reverseBacks: boolean,
): Side[] {
  const sides: Side[] = [];
  imp.sheets.forEach((sh, i) => {
    const n = (i % imp.sheetsPerSignature) + 1;
    const label = (face: string) =>
      `sig ${sh.signature + 1} · sheet ${n} · ${face}`;
    if (mode !== "backs") {
      sides.push({ label: label("front"), slots: sh.front });
    }
    if (mode !== "fronts") sides.push({ label: label("back"), slots: sh.back });
  });
  return mode === "backs" && reverseBacks ? sides.reverse() : sides;
}

/**
 * One landscape PDF page per side. `source` is the trim-size book PDF whose
 * pages get embedded; null draws numbered proof placeholders instead.
 */
export async function buildSheetPdf(
  sides: Side[],
  geom: SheetGeometry,
  source: Uint8Array | null,
): Promise<Uint8Array> {
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
    const at = slot.rotate === 180
      ? { x: x + pw, y: y + ph, rotate: degrees(180) }
      : { x, y, rotate: degrees(0) };
    if (slot.page === null) return;
    if (source) {
      const emb = embedded[slot.page];
      if (!emb) throw new Error(`book.pdf has no page ${slot.page + 1}`);
      page.drawPage(emb, { ...at, width: pw, height: ph });
      return;
    }
    // Proof placeholder: border, big page number, and where this slot sits.
    page.drawRectangle({
      x,
      y,
      width: pw,
      height: ph,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 0.5,
    });
    const num = String(slot.page + 1);
    const size = 72;
    page.drawText(num, {
      x: x + pw / 2 - font.widthOfTextAtSize(num, size) / 2,
      y: y + ph / 2 - size / 3,
      size,
      font,
      ...(slot.rotate === 180
        ? {
          rotate: degrees(180),
          x: x + pw / 2 + font.widthOfTextAtSize(num, size) / 2,
          y: y + ph / 2 + size / 3,
        }
        : {}),
    });
    const caption = `${label} · folio ${slot.folio}`;
    page.drawText(
      caption,
      slot.rotate === 180
        ? { x: x + pw - 8, y: y + ph - 8, size: 8, font, rotate: degrees(180) }
        : { x: x + 8, y: y + 8, size: 8, font },
    );
  };

  for (const side of sides) {
    const page = out.addPage([W, H]);
    side.slots.forEach((slot, i) => drawSlot(page, slot, i, side.label));
  }
  return await out.save();
}

export interface ExportOptions {
  folios?: number;
  sheet?: string;
  duplex?: Flip | "none";
  flip?: Flip;
  reverseBacks?: boolean;
  proof?: boolean;
  pages?: number; // proof only
  out?: string;
  /** Test seam: swap the Chrome-based renderer for a stub that returns pdf-lib bytes directly. */
  render?: (html: string) => Promise<Uint8Array>;
}

export interface ExportSummary {
  pageCount: number;
  imposition: Imposition;
  files: string[];
  diagnostics: number;
  resolved: { sheet: string; duplex: string; folios: number };
}

function assertWholeNumber(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a whole number ≥ 1 (got ${value})`);
  }
}

const DUPLEX_VALUES = ["short-edge", "long-edge", "none"] as const;
const FLIP_VALUES = ["short-edge", "long-edge"] as const;

function assertOneOf<T extends string>(
  value: T,
  allowed: readonly T[],
  label: string,
): void {
  if (!allowed.includes(value)) {
    const list = allowed.length > 2
      ? `${allowed.slice(0, -1).join(", ")}, or ${allowed[allowed.length - 1]}`
      : allowed.join(" or ");
    throw new Error(`${label} must be ${list} (got ${JSON.stringify(value)})`);
  }
}

export async function exportBook(
  booksRoot: string,
  book: string,
  opts: ExportOptions,
): Promise<ExportSummary> {
  const bookDir = `${booksRoot}/${book}`;
  try {
    await Deno.stat(`${bookDir}/manuscript.md`);
  } catch {
    throw new Error(`no such book: ${book}`);
  }
  const meta = (await loadMetadata(`${bookDir}/metadata.json`)) ?? {};
  const folios = opts.folios ?? meta.print?.["folios-per-signature"] ?? 4;
  assertWholeNumber(folios, "folios-per-signature");
  if (opts.pages !== undefined) assertWholeNumber(opts.pages, "pages");
  const sheetName = opts.sheet ?? meta.print?.["sheet-size"] ?? "letter";
  const duplex = opts.duplex ?? meta.print?.duplex ?? "short-edge";
  assertOneOf(duplex, DUPLEX_VALUES, "duplex");
  const flip = opts.flip ?? "short-edge";
  assertOneOf(flip, FLIP_VALUES, "flip");
  const sheet = parseDims(sheetName);
  const out = opts.out ?? `${bookDir}/export`;
  await Deno.mkdir(out, { recursive: true });

  let source: Uint8Array | null = null;
  let page: Dims;
  let pageCount: number;
  let diagnostics = 0;
  const files: string[] = [];
  if (opts.proof) {
    // No PDF exists yet to measure — fall back to the metadata-declared trim size.
    page = parseDims(meta.page?.size ?? "5.5in 8.5in");
    pageCount = opts.pages ?? 4 * folios;
  } else {
    const imagesDir = `file://${await Deno.realPath(bookDir)}/images`;
    const built = await buildBook(booksRoot, book, {
      imageUrlPrefix: imagesDir,
    });
    diagnostics = built.diagnostics.length;
    source = await (opts.render ?? renderPdf)(toHtml(built));
    const src = await PDFDocument.load(source);
    pageCount = src.getPageCount();
    const { width, height } = src.getPage(0).getSize();
    page = { w: width / PT, h: height / PT }; // trim size comes from the rendered PDF, not metadata
    await Deno.writeFile(`${out}/book.pdf`, source);
    files.push(`${out}/book.pdf`);
  }

  const imposition = impose(pageCount, { folios, sheet, page, duplex, flip });
  const geom: SheetGeometry = { sheet, page, nUp: imposition.nUp };
  if (duplex === "none") {
    for (
      const [name, mode] of [["sheets-fronts.pdf", "fronts"], [
        "sheets-backs.pdf",
        "backs",
      ]] as const
    ) {
      const path = `${out}/${name}`;
      await Deno.writeFile(
        path,
        await buildSheetPdf(
          sidesFor(imposition, mode, opts.reverseBacks ?? false),
          geom,
          source,
        ),
      );
      files.push(path);
    }
  } else {
    const path = `${out}/sheets.pdf`;
    await Deno.writeFile(
      path,
      await buildSheetPdf(sidesFor(imposition, "duplex", false), geom, source),
    );
    files.push(path);
  }
  return {
    pageCount,
    imposition,
    files,
    diagnostics,
    resolved: { sheet: sheetName, duplex, folios },
  };
}

export function formatSummary(
  book: string,
  s: ExportSummary,
  cfg: { sheet: string; duplex: string },
): string {
  const i = s.imposition;
  const folios = s.resolved.folios;
  const lines = [
    `${book}: ${s.pageCount} pages → ${i.paddedCount} padded · ${i.signatures} signature${
      i.signatures === 1 ? "" : "s"
    } × ${folios} folios · ${i.nUp}-up on ${cfg.sheet} · ${i.sheets.length} sheets · duplex ${cfg.duplex}`,
  ];
  if (i.wastedFolioSlots > 0) {
    lines.push(
      `warning: ${i.wastedFolioSlots} blank folio slot${
        i.wastedFolioSlots === 1 ? "" : "s"
      } per signature (cut half is waste)`,
    );
  }
  return lines.join("\n");
}
