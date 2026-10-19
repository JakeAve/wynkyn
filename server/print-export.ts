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
  type Slot,
} from "./imposition.ts";
import { metadataPath } from "./editions.ts";
import { type PageSetup, resolvePageSetup } from "../metadata/page-setup.ts";
import { loadMetadata } from "../metadata/loader.ts";
import { buildBook, toHtml } from "./pipeline.ts";
import { type RenderedPdf, renderPdf } from "./pdf.ts";
import {
  formatProblem,
  type PageProblem,
  type Seed,
} from "../renderer/page-map-types.ts";

const PT = 72; // points per inch

export interface SheetGeometry {
  sheet: Dims;
  page: Dims;
  nUp: number; // pages per sheet side; cols × rows
  cols: number;
  rows: number;
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
  // The grid already fixed the sheet's orientation — a quartered setup prints
  // portrait, a 2-up one landscape — so take these dimensions as given.
  const W = geom.sheet.w * PT;
  const H = geom.sheet.h * PT;
  const pw = geom.page.w * PT;
  const ph = geom.page.h * PT;
  const x0 = (W - geom.cols * pw) / 2; // grid of pages centred on the sheet
  const y0 = (H - geom.rows * ph) / 2;

  let embedded: PDFEmbeddedPage[] = [];
  if (source) {
    const src = await PDFDocument.load(source);
    embedded = await out.embedPdf(src, src.getPageIndices());
  }

  const drawSlot = (page: PDFPage, slot: Slot, i: number, label: string) => {
    // Slots arrive row-major; PDF y grows upward, so row 0 is the top one.
    const x = x0 + (i % geom.cols) * pw;
    const y = y0 + (geom.rows - 1 - Math.floor(i / geom.cols)) * ph;
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
  edition?: string | null; // null/undefined = the unnamed edition
  force?: boolean; // export despite pagination problems
  /** Test seam: swap the Chrome-based renderer for a stub that returns pdf-lib bytes directly. */
  render?: (html: string) => Promise<RenderedPdf>;
}

export interface ExportSummary {
  pageCount: number;
  imposition: Imposition;
  files: string[];
  diagnostics: number;
  setup: PageSetup; // the §4.3 page setup this run actually used
  pagination: PageProblem[]; // page map problems, exported anyway under force
}

function assertWholeNumber(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a whole number ≥ 1 (got ${value})`);
  }
}

const FLIP_VALUES = ["short-edge", "long-edge"] as const;

/**
 * The last export's settled folios (`page-map.json`), used only when it was
 * saved for this exact page (`inputHash`, see exportBook) — so an unchanged
 * book renders once and reproduces that export exactly, and anything else
 * (another book or edition in a shared --out, any edit, a corrupt file)
 * starts clean from {}, landing where a clean run would.
 */
async function readSeed(path: string, inputHash: string): Promise<Seed> {
  try {
    const saved = JSON.parse(await Deno.readTextFile(path));
    const seed = saved?.seed;
    if (
      saved?.inputHash === inputHash && seed && typeof seed === "object" &&
      !Array.isArray(seed) &&
      Object.values(seed).every((v) => typeof v === "string")
    ) return seed;
  } catch {
    // missing or unreadable — start fresh
  }
  return {};
}

/** Hex SHA-256 of `text`. */
async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
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
  const edition = opts.edition ?? null;
  const meta = await loadMetadata(metadataPath(booksRoot, book, edition));
  if (meta === null && edition !== null) {
    throw new Error(`no such edition: ${book}/${edition}`);
  }
  const m = meta ?? {};
  // One resolver for the whole §4.3 setup, shared with the config panel, so a
  // bad setup fails here with the same message the panel shows — and before we
  // spend a Chrome render on it.
  const setup = resolvePageSetup(m.page, {
    sheet: opts.sheet,
    folios: opts.folios,
    duplex: opts.duplex,
  });
  if (setup.error !== null) throw new Error(setup.error);
  const { folios, duplex, sheetDims: sheet } = setup;
  if (opts.pages !== undefined) assertWholeNumber(opts.pages, "pages");
  const flip = opts.flip ?? "short-edge";
  if (!FLIP_VALUES.includes(flip)) {
    throw new Error(
      `flip must be short-edge or long-edge (got ${JSON.stringify(flip)})`,
    );
  }
  const out = opts.out ??
    (edition === null ? `${bookDir}/export` : `${bookDir}/export/${edition}`);
  await Deno.mkdir(out, { recursive: true });

  let source: Uint8Array | null = null;
  let page: Dims;
  let pageCount: number;
  let diagnostics = 0;
  let pagination: PageProblem[] = [];
  const files: string[] = [];
  if (opts.proof) {
    // No PDF exists yet to measure — fall back to the configured page size.
    page = setup.page;
    pageCount = opts.pages ?? 4 * folios;
  } else {
    const imagesDir = `file://${await Deno.realPath(bookDir)}/images`;
    const built = await buildBook(booksRoot, book, {
      imageUrlPrefix: imagesDir,
      edition,
    });
    diagnostics = built.diagnostics.length;
    const pageMapPath = `${out}/page-map.json`;
    // The unseeded page is every layout input (book HTML, CSS, font links,
    // numbering, title, Paged.js and the handlers), so its hash keys the seed.
    // ponytail: image bytes aren't hashed; a replaced image with new
    // dimensions under the same name keeps the old seed. Hash them if that bites.
    const inputHash = await sha256(toHtml(built));
    const rendered = await (opts.render ?? renderPdf)(
      toHtml(built, { seed: await readSeed(pageMapPath, inputHash) }),
    );
    pagination = rendered.problems;
    if (pagination.length && !opts.force) {
      throw new Error(
        `pagination problems (--force to export anyway):\n${
          pagination.map((p) => `  ${formatProblem(p)}`).join("\n")
        }`,
      );
    }
    source = rendered.pdf;
    const src = await PDFDocument.load(source);
    pageCount = src.getPageCount();
    const { width, height } = src.getPage(0).getSize();
    page = { w: width / PT, h: height / PT }; // page size comes from the rendered PDF, not metadata
    await Deno.writeFile(`${out}/book.pdf`, source);
    files.push(`${out}/book.pdf`);
    // Only a clean render's seed is a fixed point worth starting from.
    if (!pagination.length) {
      await Deno.writeTextFile(
        pageMapPath,
        JSON.stringify({ inputHash, seed: rendered.seed }, null, 2) + "\n",
      );
      files.push(pageMapPath);
    }
  }

  const imposition = impose(pageCount, { folios, sheet, page, duplex, flip });
  const geom: SheetGeometry = {
    sheet: imposition.sheet, // oriented by the grid, not by `sheet` as parsed
    page,
    nUp: imposition.nUp,
    cols: imposition.cols,
    rows: imposition.rows,
  };
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
    setup,
    pagination,
  };
}

export function formatSummary(book: string, s: ExportSummary): string {
  const i = s.imposition;
  const { folios, sheet, duplex } = s.setup;
  const lines = [
    `${book}: ${s.pageCount} pages → ${i.paddedCount} padded · ${i.signatures} signature${
      i.signatures === 1 ? "" : "s"
    } × ${folios} folios · ${i.nUp}-up on ${sheet} · ${i.sheets.length} sheets · duplex ${duplex}`,
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
