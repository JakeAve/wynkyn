// web/src/panel-page.ts — the style panel's Page and Publish tabs (spec R1).
// Page: trim size and margins (page numbers and running heads are Page
// furniture parts, panel-furniture.ts). Publish: the sheet,
// signatures and the imposition they derive to (§4.3), the first signature
// drawn as it prints into the sheet view (R7), printing from this browser and
// the print export. Both write the `page` section; Publish reads the trim size
// the Page tab set, and exports the e-book (§7.8).
import type { Duplex, Flip, PageConfig } from "../../metadata/types.ts";
import {
  DEFAULT_SIZE,
  fmtLength,
  isValidFolios,
  isValidSize,
  PAGE_SIZE_PRESETS,
  parseLength,
  presetFor,
  resolvePageSetup,
  SHEET_PRESETS,
  type SizePreset,
  tryParseDims,
} from "./config-data.ts";
import {
  makeView,
  row,
  section,
  seg,
  select,
  stepper,
  switchInput,
} from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";
import {
  impose,
  type Imposition,
  sidesFor,
  type Slot,
} from "../../server/imposition.ts";
import type { PageSetup } from "../../metadata/page-setup.ts";
import { printSheets } from "./print.ts";

const MARGINS = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["inside", "Inside"],
  ["outside", "Outside"],
] as const;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = className;
  e.append(...kids);
  return e;
};

// A CSS length in inches, for drawing only; 0 when it isn't one.
const inches = (v: string | undefined) =>
  v ? tryParseDims(`${v} ${v}`)?.w ?? 0 : 0;

export function buildPageTab(panel: PanelContext): Node[] {
  // Every save in this tab repaints the dots.
  const v = makeView(panel);
  const ctx: PanelContext = { ...panel, queueSave: v.changed };
  const page: PageConfig = ctx.meta.page ??= {};
  // Read-only snapshot — must not eagerly create page.margins, or an edit to
  // an unrelated field (e.g. size) would persist a spurious empty margins
  // object on save (the whole "page" section round-trips together).
  const margins = page.margins ?? {};

  const H = 138; // px, the drawn page height (matches .mpage in index.html)
  const block = el("div", "mblock");
  const vblock = el("div", "mblock");
  const pageR = el("div", "mpage", block);
  const pageV = el("div", "mpage v", vblock);
  const draw = () => {
    const trim = tryParseDims(page.size ?? DEFAULT_SIZE) ??
      tryParseDims(DEFAULT_SIZE)!;
    const s = H / trim.h;
    const w = H * trim.w / trim.h;
    pageR.style.width = `${w.toFixed(1)}px`;
    pageV.style.width = `${(w / 2.4).toFixed(1)}px`;
    const m = page.margins ?? {};
    const px = (v: string | undefined) => `${inches(v) * s}px`;
    Object.assign(block.style, {
      top: px(m.top),
      bottom: px(m.bottom),
      left: px(m.inside),
      right: px(m.outside),
    });
    Object.assign(vblock.style, {
      top: px(m.top),
      bottom: px(m.bottom),
      left: "0",
      right: px(m.inside),
    });
  };
  draw();

  const unit = Object.values(margins).map((v) => parseLength(v)?.unit)
    .find(Boolean) ?? "mm";
  const diag = el(
    "div",
    "mdiag",
    el("div", "stage", pageV, pageR),
    ...MARGINS.map(([key, label]) =>
      el(
        "label",
        `mlab m${key[0]}`,
        label,
        stepper({
          value: margins[key],
          placeholder: `0${unit}`,
          label: `${label} margin`,
          onChange: (v) => {
            const m = page.margins ??= {};
            if (v) m[key] = v;
            else delete m[key];
            draw();
            ctx.queueSave("page");
          },
        }),
      )
    ),
  );

  return [
    section("Trim size", "trim", [
      v.mark(
        row(
          "Page",
          sizeControl(page.size, "Trim size", (size) => {
            page.size = size;
            draw();
            ctx.queueSave("page");
          }),
        ),
        () => !!page.size,
      ),
    ]),
    section("Margins", "margins", [
      diag,
      el(
        "p",
        "hint",
        "Inside is the spine edge. The preview shows the spread as it will fold.",
      ),
      el(
        "p",
        "hint",
        "Page numbers and running heads are under Book parts, Page furniture.",
      ),
    ]),
  ];
}

export function buildPublishTab(ctx: PanelContext): Node[] {
  const page: PageConfig = ctx.meta.page ??= {};
  const readout = el("div", "readout");
  // Redrawn on every edit and every repagination: a booklet's size and the
  // pages that land on each sheet both follow the book's page count.
  const redraw = () => {
    const pages = ctx.preview.pageCount();
    const setup = resolvePageSetup(page, { pageCount: pages || undefined });
    showSetup(setup, pages, readout);
    drawSignature(ctx, setup, pages, page.flip ?? "short-edge", ctx.sheetView);
  };
  const v = makeView(ctx, redraw);
  const save = () => v.changed("page");
  ctx.onPages(redraw);
  redraw();

  // Printing the backs by hand: how the stack goes back in.
  const manual = [
    v.mark(
      row(
        "Turn over",
        seg<Flip>(
          [
            { label: "Short edge", value: "short-edge" },
            { label: "Long edge", value: "long-edge" },
          ],
          page.flip ?? "short-edge",
          (f) => {
            if (f) page.flip = f;
            save();
          },
          "Edge the stack turns over on",
        ),
      ),
      () => !!page.flip,
    ),
    v.mark(
      row(
        "Last sheet first",
        switchInput(
          "Last sheet first",
          page["reverse-backs"] === true,
          (on) => {
            if (on) page["reverse-backs"] = true;
            else delete page["reverse-backs"];
            save();
          },
        ),
      ),
      () => page["reverse-backs"] === true,
    ),
    el(
      "p",
      "hint",
      "Print the fronts, turn the stack over on that edge and put it back in, then print the backs. Last sheet first suits printers that stack face up.",
    ),
  ];
  const printing = printSection(ctx, page);
  const showManual = () => {
    for (const m of manual) m.hidden = (page.duplex ?? "short-edge") !== "none";
    printing.update();
  };
  showManual();

  const FPS = "folios-per-signature";
  let lastFolios = typeof page[FPS] === "number" ? page[FPS] : undefined;
  const folioRow = v.mark(
    row(
      "Folios each",
      stepper({
        value: lastFolios?.toString(),
        placeholder: "4",
        label: "Folios per signature",
        onChange: (n) => {
          if (n === undefined) delete page[FPS];
          else if (isValidFolios(n)) page[FPS] = lastFolios = Number(n);
          else return false; // 0 or a fraction: show the saved value
          save();
        },
      }),
    ),
    () => typeof page[FPS] === "number",
  );
  folioRow.hidden = page[FPS] === "booklet";

  return [
    section("Paper", "sheet", [
      v.mark(
        row(
          "Sheet",
          sizeControl(page.sheet, "Sheet size", (sheet) => {
            page.sheet = sheet;
            save();
          }, SHEET_PRESETS),
        ),
        () => !!page.sheet,
      ),
      v.mark(
        row(
          "Two-sided",
          seg<Duplex>(
            [
              { label: "Short edge", value: "short-edge" },
              { label: "Long edge", value: "long-edge" },
              { label: "By hand", value: "none" },
            ],
            page.duplex ?? "short-edge",
            (d) => {
              if (d) page.duplex = d;
              showManual();
              save();
            },
            "Duplex",
          ),
        ),
        () => !!page.duplex,
      ),
      ...manual,
    ]),
    section("Signatures", "folios-per-signature", [
      v.mark(
        row(
          "Booklet",
          switchInput("One signature", page[FPS] === "booklet", (on) => {
            if (on) page[FPS] = "booklet";
            else if (lastFolios !== undefined) page[FPS] = lastFolios;
            else delete page[FPS];
            folioRow.hidden = on;
            save();
          }),
        ),
        () => page[FPS] === "booklet",
      ),
      folioRow,
      readout,
    ]),
    printing.sec,
    exportSection(ctx, page),
    ebookSection(ctx),
  ];
}

// The pages as they land on sheets, from the live preview's count: the same
// impose() the export runs, so the sheet view, the browser print and the
// PDFs agree. Before the preview paginates, one signature's worth.
function liveImposition(
  ctx: PanelContext,
  setup: Extract<PageSetup, { error: null }>,
  pageCount: number,
  flip: Flip,
): Imposition {
  return impose(pageCount || setup.pagesPerSignature, {
    folios: setup.folios,
    sheet: setup.sheetDims,
    page: setup.page,
    duplex: setup.duplex,
    flip,
    tail: pageCount && ctx.preview.endsWithColophon() ? 1 : 0,
  });
}

// Print from this browser: the sheets, imposed like sheets.pdf, straight to
// the print dialog, so the server needs no Chrome. A by-hand job is two runs,
// fronts then backs, like its two PDFs. update() follows the duplex setting.
function printSection(
  ctx: PanelContext,
  page: PageConfig,
): { sec: HTMLElement; update(): void } {
  const status = el("div", "export-status");
  status.setAttribute("aria-live", "polite");
  const run = (mode: "duplex" | "fronts" | "backs") => {
    status.replaceChildren();
    const pages = ctx.preview.pages();
    if (!pages.length) {
      status.append(
        el("p", "err", "Nothing to print until the preview has paginated."),
      );
      return;
    }
    const setup = resolvePageSetup(page, { pageCount: pages.length });
    if (setup.error !== null) {
      status.append(el("p", "err", setup.error));
      return;
    }
    const imp = liveImposition(
      ctx,
      setup,
      pages.length,
      page.flip ?? "short-edge",
    );
    printSheets(pages, sidesFor(imp, mode, page["reverse-backs"] === true), {
      sheet: imp.sheet,
      page: setup.page,
      cols: imp.cols,
      rows: imp.rows,
    });
  };
  const btn = (label: string, mode: "duplex" | "fronts" | "backs") => {
    const b = el("button", "tog primary", label);
    b.type = "button";
    b.onclick = () => run(mode);
    return b;
  };
  const sheets = btn("Print sheets", "duplex");
  const fronts = btn("Print fronts", "fronts");
  const backs = btn("Print backs", "backs");
  const dialog = el("p", "hint");
  const update = () => {
    const duplex = page.duplex ?? "short-edge";
    sheets.hidden = duplex === "none";
    fronts.hidden = backs.hidden = duplex !== "none";
    dialog.textContent = duplex === "none"
      ? "In the print dialog choose the sheet size and 100% scale, for the fronts and again for the backs."
      : `In the print dialog choose the sheet size, 100% scale and two-sided on the ${
        duplex === "short-edge" ? "short" : "long"
      } edge.`;
  };
  update();
  return {
    update,
    sec: section("Print", "print", [
      el("div", "actions", sheets, fronts, backs),
      el(
        "p",
        "hint",
        "Prints the sheets from this browser (Chrome or Edge), nothing on the server. Save as PDF gives the same file the export does.",
      ),
      dialog,
      status,
    ]),
  };
}

// One button: the EPUB, then a link to it. It reflows on the reader's screen,
// so nothing above it (sheet, signatures, folios) applies.
function ebookSection(ctx: PanelContext): HTMLElement {
  const status = el("div", "export-status");
  status.setAttribute("aria-live", "polite");
  const btn = el("button", "tog primary", "Export EPUB");
  btn.type = "button";
  btn.onclick = async () => {
    btn.disabled = true;
    status.replaceChildren(el("p", "", "Building the e-book…"));
    const r = await ctx.exportEpub();
    btn.disabled = false;
    status.replaceChildren();
    if (r.error || !r.file) {
      status.append(el("p", "err", r.error ?? "The export failed."));
      return;
    }
    const a = el("a", "", r.file.name);
    a.href = r.file.url;
    a.download = r.file.name;
    status.append(
      el("p", "", `${r.documents} documents.`),
      el("div", "files", a),
      el(
        "p",
        "hint",
        "Open it in Apple Books, or send it to a Kindle, to check it.",
      ),
    );
  };
  return section("E-book", "ebook", [
    el("div", "actions", btn),
    el(
      "p",
      "hint",
      "An EPUB reflows to the reader's screen: paper, signatures and page numbers do not apply. Notes go to the end of their chapter. Its language is the one set in Body text; cover and identifier come from the ebook section of metadata.json.",
    ),
    status,
  ]);
}

// The derived half of the setup: what these values actually produce on paper.
function showSetup(
  setup: PageSetup,
  pageCount: number,
  readout: HTMLElement,
): void {
  readout.textContent = "";
  readout.classList.toggle("cfg-readout-bad", setup.error !== null);
  const line = (text: string) => readout.append(el("p", "", text));
  if (setup.error !== null) {
    line(setup.error);
    return;
  }
  const folioWord = setup.foliosPerSheet === 1 ? "folio" : "folios";
  const cuts = setup.cutsPerSheet === 0
    ? "fold only, no cuts"
    : `${setup.cutsPerSheet} cut${setup.cutsPerSheet === 1 ? "" : "s"}`;
  // The grid only earns a mention once it has more than one row — that is
  // where the sheet turns portrait and gets cut across before folding.
  const grid = setup.rows === 1 ? "" : ` (${setup.cols} × ${setup.rows})`;
  line(
    `${setup.nUp}-up on ${setup.sheet}${grid}: ${setup.foliosPerSheet} ${folioWord} per sheet, ${cuts}`,
  );
  if (setup.rows > 1) {
    line(
      `Sheet prints ${
        setup.landscape ? "landscape" : "portrait"
      }: cut across, then fold each piece down its center`,
    );
  }
  const sheets = `${setup.sheetsPerSignature} sheet${
    setup.sheetsPerSignature === 1 ? "" : "s"
  }`;
  if (setup.booklet && !pageCount) {
    line("Booklet: sized once the preview has paginated");
  } else if (setup.booklet) {
    line(
      `Booklet: all ${pageCount} pages in one ${setup.folios}-folio signature, ${sheets}`,
    );
  } else {
    line(
      `${sheets} per ${setup.folios}-folio signature = ${setup.pagesPerSignature} book pages`,
    );
  }
  const EPS = 5e-4;
  if (setup.slackAcross > EPS || setup.slackDown > EPS) {
    line(
      `Leftover paper: ${fmtLength(setup.slackAcross, setup.unit)} across, ${
        fmtLength(setup.slackDown, setup.unit)
      } down, trimmed off after folding`,
    );
  } else {
    line("The page tiles the sheet exactly, nothing to trim off");
  }
}

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  ...kids: Array<Node | string>
): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
};

const SHOWN_SHEETS = 4; // a booklet can run to dozens; the first few tell the story

// The first signature as it prints (spec R7): each sheet's front and back with
// the book pages that land on it, the folds dashed and the cuts solid. Uses
// the same impose() the export does, so the drawing is the printed sheet.
function drawSignature(
  ctx: PanelContext,
  setup: PageSetup,
  pageCount: number,
  flip: Flip,
  host: HTMLElement,
): void {
  host.replaceChildren();
  if (setup.error !== null) return;
  const imp = liveImposition(ctx, setup, pageCount, flip);
  const first = imp.sheets.filter((sh) => sh.signature === 0);
  const { w: W, h: H } = imp.sheet;
  const { w: pw, h: ph } = setup.page;
  const x0 = (W - imp.cols * pw) / 2; // centred, as buildSheetPdf lays it out
  const y0 = (H - imp.rows * ph) / 2;
  const side = (slots: Slot[], label: string) => {
    const s = svg("svg", {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `${label}: pages ${
        slots.map((t) => t.page === null ? "blank" : t.page + 1).join(", ")
      }`,
    }, svg("rect", { class: "paper", width: W, height: H }));
    slots.forEach((slot, i) => {
      const x = x0 + (i % imp.cols) * pw;
      const y = y0 + Math.floor(i / imp.cols) * ph;
      s.append(svg("rect", {
        class: slot.page === null ? "slot blank" : "slot",
        x,
        y,
        width: pw,
        height: ph,
      }));
      if (slot.page === null) return;
      const cx = x + pw / 2;
      const cy = y + ph / 2;
      s.append(svg("text", {
        x: cx,
        y: cy,
        "font-size": Math.min(pw, ph) * 0.4,
        transform: slot.rotate ? `rotate(180 ${cx} ${cy})` : "",
      }, String(slot.page + 1)));
    });
    for (let r = 0; r < imp.rows; r++) {
      const y = y0 + r * ph;
      for (let c = 1; c < imp.cols; c++) {
        const x = x0 + c * pw;
        s.append(svg("line", {
          class: c % 2 ? "fold" : "cut",
          x1: x,
          x2: x,
          y1: y,
          y2: y + ph,
        }));
      }
      if (r > 0) {
        s.append(svg("line", {
          class: "cut",
          x1: x0,
          x2: x0 + imp.cols * pw,
          y1: y,
          y2: y,
        }));
      }
    }
    return el("figure", "", s, el("figcaption", "", label));
  };
  first.slice(0, SHOWN_SHEETS).forEach((sh, i) =>
    host.append(
      el(
        "div",
        "sheet",
        side(sh.front, `Sheet ${i + 1} front`),
        side(sh.back, `Sheet ${i + 1} back`),
      ),
    )
  );
  const more = first.length - SHOWN_SHEETS;
  const notes = [
    more > 0 ? `And ${more} more sheet${more === 1 ? "" : "s"}.` : "",
    setup.cutsPerSheet
      ? "Dashed lines fold, solid lines cut."
      : "Dashed lines fold.",
    first.some((sh) => sh.back.some((t) => t.rotate))
      ? "Upside-down numbers print upside down, which is how the back lines up."
      : "",
  ];
  host.append(el("p", "hint", notes.filter(Boolean).join(" ")));
}

const FILE_LABELS: Record<string, string> = {
  "sheets.pdf": "Sheets",
  "sheets-fronts.pdf": "Fronts",
  "sheets-backs.pdf": "Backs",
  "book.pdf": "Pages in reading order",
};

// Proof and export buttons, then what the export wrote, each PDF opening in
// the browser's viewer to print from.
function exportSection(ctx: PanelContext, page: PageConfig): HTMLElement {
  const status = el("div", "export-status");
  status.setAttribute("aria-live", "polite");
  const proofBtn = el("button", "tog", "Proof");
  const exportBtn = el("button", "tog primary", "Export");
  proofBtn.type = exportBtn.type = "button";
  const say = (cls: string, text: string) => el("p", cls, text);

  const run = async (proof: boolean, force = false) => {
    proofBtn.disabled = exportBtn.disabled = true;
    status.replaceChildren(say(
      "",
      proof
        ? "Building the proof…"
        : "Rendering the book in Chrome. This can take a minute…",
    ));
    const pages = ctx.preview.pageCount();
    const r = await ctx.exportPrint({
      proof,
      force,
      // A booklet's proof is the whole book; other proofs show one signature.
      pages: proof && page["folios-per-signature"] === "booklet" && pages
        ? pages
        : undefined,
    });
    proofBtn.disabled = exportBtn.disabled = false;
    status.replaceChildren();
    if (r.error) {
      status.append(say("err", r.error));
      return;
    }
    if (!r.summary) {
      const again = el("button", "tog", "Export anyway");
      again.type = "button";
      again.onclick = () => run(proof, true);
      status.append(
        say("err", "Pagination problems. Fix them, or export anyway:"),
        el("ul", "", ...r.problems.map((p) => el("li", "", p))),
        again,
      );
      return;
    }
    status.append(...r.summary.split("\n").map((l) => say("", l)));
    if (r.problems.length) {
      status.append(
        say(
          "err",
          `Exported with ${r.problems.length} pagination problem${
            r.problems.length === 1 ? "" : "s"
          }.`,
        ),
      );
    }
    const links = el("div", "files");
    for (const f of r.files) {
      const a = el("a", "", FILE_LABELS[f.name] ?? f.name);
      a.href = f.url;
      a.target = "_blank";
      a.rel = "noopener";
      links.append(a);
    }
    status.append(
      links,
      say("hint", "Print at 100% (actual size), never fit to page."),
    );
  };
  proofBtn.onclick = () => run(true);
  exportBtn.onclick = () => run(false);

  return section("Export", "export", [
    el("div", "actions", proofBtn, exportBtn),
    el(
      "p",
      "hint",
      "A proof prints numbered blank pages. On a new printer, fold one signature by hand before using good paper.",
    ),
    status,
  ]);
}

// Preset dropdown + custom-dimensions input (spec §7.5: named presets and
// custom dimensions), over either the book-page or the sheet preset list.
// Calls onChange only with valid values; invalid custom input shows an error.
function sizeControl(
  current: string | undefined,
  label: string,
  onChange: (size: string) => void,
  presets: SizePreset[] = PAGE_SIZE_PRESETS,
): HTMLElement {
  const wrap = el("span", "cfg-row");
  const preset = presetFor(current, presets);
  const custom = document.createElement("input");
  custom.type = "text";
  custom.className = "txt";
  custom.placeholder = "5.5in 8.5in";
  custom.setAttribute("aria-label", `Custom ${label.toLowerCase()}`);
  custom.value = preset === "custom" ? (current ?? "") : "";
  custom.hidden = preset !== "custom";
  const error = el("span", "cfg-error");
  const sel = select(
    [
      ...presets.map((p) => ({ label: p.label, value: p.value })),
      { label: "Custom…", value: "custom" },
    ],
    preset,
    (v) => {
      custom.hidden = v !== "custom";
      error.textContent = "";
      if (v !== "custom") onChange(v);
    },
    label,
  );
  custom.oninput = () => {
    const v = custom.value.trim();
    if (isValidSize(v)) {
      error.textContent = "";
      onChange(v);
    } else {
      error.textContent = "e.g. “5.5in 8.5in” or a named size";
    }
  };
  wrap.append(sel, custom, error);
  return wrap;
}
