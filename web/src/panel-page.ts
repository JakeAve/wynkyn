// web/src/panel-page.ts — the style panel's Page and Publish tabs (spec R1).
// Page: trim size and margins (page numbers and running heads are Page
// furniture parts, panel-furniture.ts). Publish, by what the author is
// making: the e-book (§7.8); a PDF of the pages at their trim size; or sheets
// for binding — paper, signatures and the imposition they derive to (§4.3),
// the first signature drawn as it prints into the sheet view (R7), and printing
// from this browser. Both write the `page` section; Publish reads the trim size
// the Page tab set and links back to it.
import type { Duplex, Flip, Fold, PageConfig } from "../../metadata/types.ts";
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
  icon,
  makeView,
  row,
  section,
  seg,
  select,
  stepper,
  swatches,
  switchInput,
} from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";
import {
  impose,
  type Imposition,
  sidesFor,
  type Slot,
} from "../../server/imposition.ts";
import {
  FOLD_VALUES,
  isTrueFold,
  type PageSetup,
  TRUE_FOLDS,
} from "../../metadata/page-setup.ts";
import { printSheets } from "./print.ts";

const FOLD_LABELS: Record<Fold, string> = {
  folio: "Folio",
  quarto: "Quarto",
  octavo: "Octavo",
  cut: "Cut, then fold",
  leaves: "Loose leaves",
};

// The preview's paper (design-language.md §2.5); print and EPUB stay white.
const PAPER_STOCKS = [
  { value: "", label: "Bright white" },
  { value: "#fbf8f1", label: "Natural" },
  { value: "#f8f2e3", label: "Ivory" },
  { value: "#f3e9d2", label: "Cream" },
  { value: "#f1f0ec", label: "Recycled grey" },
];

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

  const H = 8.625; // rem, the drawn page height (matches .mpage in app.css)
  const block = el("div", "mblock");
  const vblock = el("div", "mblock");
  const pageR = el("div", "mpage", block);
  const pageV = el("div", "mpage v", vblock);
  const draw = () => {
    const trim = tryParseDims(page.size ?? DEFAULT_SIZE) ??
      tryParseDims(DEFAULT_SIZE)!;
    const s = H / trim.h;
    const w = H * trim.w / trim.h;
    pageR.style.width = `${w.toFixed(3)}rem`;
    pageV.style.width = `${(w / 2.4).toFixed(3)}rem`;
    const m = page.margins ?? {};
    const rem = (v: string | undefined) => `${inches(v) * s}rem`;
    Object.assign(block.style, {
      top: rem(m.top),
      bottom: rem(m.bottom),
      left: rem(m.inside),
      right: rem(m.outside),
    });
    Object.assign(vblock.style, {
      top: rem(m.top),
      bottom: rem(m.bottom),
      left: "0",
      right: rem(m.inside),
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
      v.mark(
        row(
          "Paper stock",
          swatches(PAPER_STOCKS, page.paper, (paper) => {
            if (paper) page.paper = paper;
            else delete page.paper;
            ctx.queueSave("page");
          }, "Paper stock"),
        ),
        () => !!page.paper,
      ),
    ]),
    section("Margins", "margins", [
      diag,
      el(
        "p",
        "tip",
        el("span", "manicule", "☞"),
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
    // Auto names what it picked; loose leaves have no signatures to set.
    foldSel.options[0]!.text = setup.error === null
      ? `Auto: ${FOLD_LABELS[setup.fold].toLowerCase()}`
      : "Auto";
    signatures.hidden = setup.error === null && setup.fold === "leaves";
  };
  const v = makeView(ctx, redraw);
  const save = () => v.changed("page");
  ctx.onPages(redraw);

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
  const FPS = "folios-per-signature";
  let lastFolios = typeof page[FPS] === "number" ? page[FPS] : undefined;
  const folioRow = v.mark(
    row(
      "Folios each",
      stepper({
        value: lastFolios?.toString(),
        placeholder: "4",
        label: "Folios per signature",
        // A folded quarto or octavo nests whole: step by its folios a sheet.
        step: () => {
          const s = resolvePageSetup(page);
          return s.error === null && isTrueFold(s.fold) ? s.foliosPerSheet : 1;
        },
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

  const duplex = v.mark(
    row(
      "Auto duplex",
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
  );
  duplex.querySelector(".lbl")!.append(
    info(
      "If your printer does not support duplex / two-sided printing for the sheet size, choose “By hand”.",
    ),
  );
  // The printer's settings sit with the buttons they change.
  const printing = printSection(ctx, page, [duplex, ...manual]);
  const showManual = () => {
    for (const m of manual) m.hidden = (page.duplex ?? "short-edge") !== "none";
    printing.update();
  };
  showManual();

  const foldSel = select(
    [
      { label: "Auto", value: "" },
      ...FOLD_VALUES.map((f) => ({ label: FOLD_LABELS[f], value: f })),
    ],
    page.fold ?? "",
    (f) => {
      if (f) page.fold = f as Fold;
      else delete page.fold;
      save();
    },
    "Fold",
  );
  const signatures = section("Signatures", "folios-per-signature", [
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
  ]);
  redraw();

  return [
    section("Paper", "sheet", [
      pageSizeRow(ctx, page),
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
    ]),
    section("Folding", "fold", [
      v.mark(row("Fold", foldSel), () => page.fold !== undefined),
      readout,
    ]),
    signatures,
    printing.sec,
    pagesSection(ctx),
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
    fold: setup.fold,
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
  settings: HTMLElement[],
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
    });
  };
  const btn = (label: string, mode: "duplex" | "fronts" | "backs") => {
    // One primary on a screen: Print sheets.
    const b = el(
      "button",
      mode === "duplex" ? "tog primary" : "tog outline",
      label,
    );
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
      ...settings,
      el("div", "actions", sheets, fronts, backs),
      dialog,
      status,
    ]),
  };
}

// A hover/focus tip beside a row label: the native title is the tooltip.
function info(text: string): HTMLElement {
  const b = el("button", "info", icon("info"));
  b.type = "button";
  b.title = text;
  b.setAttribute("aria-label", text);
  return b;
}

// The page size is Style's to set; Publish shows it, with the way there. The
// trip leaves a history entry, so Back returns here.
function pageSizeRow(ctx: PanelContext, page: PageConfig): HTMLElement {
  const change = el("button", "where", "Change in Style");
  change.type = "button";
  change.onclick = () =>
    ctx.toStyle(
      "page",
      change.closest<HTMLElement>("[data-focus]")!.dataset.focus!,
    );
  return row(
    "Page",
    el(
      "span",
      "cfg-row",
      (page.size ?? DEFAULT_SIZE).replace(" ", " × "),
      change,
    ),
  );
}

// The book's pages in reading order, one per printed page at the page size,
// no imposition: Save as PDF gives a file the size of the book.
function pagesSection(ctx: PanelContext): HTMLElement {
  const status = el("div", "export-status");
  status.setAttribute("aria-live", "polite");
  const btn = el("button", "tog outline", "Print pages");
  btn.type = "button";
  btn.onclick = () => {
    status.replaceChildren();
    const pages = ctx.preview.pages();
    const size = tryParseDims(ctx.meta.page?.size ?? DEFAULT_SIZE);
    if (!pages.length || !size) {
      status.append(
        el("p", "err", "Nothing to print until the preview has paginated."),
      );
      return;
    }
    const sides = pages.map((_, i) => ({
      label: `page ${i + 1}`,
      slots: [{ page: i, rotate: 0 as const, folio: 0, x: 0, y: 0 }],
      marks: { dots: [], lines: [] }, // book pages never carry binding marks
    }));
    printSheets(pages, sides, { sheet: size, page: size });
  };
  return section("PDF", "pdf", [
    el("div", "actions", btn),
    el("p", "hint", "Choose Save as PDF in the print dialog."),
    status,
  ]);
}

// One button: the EPUB, then a link to it. It reflows on the reader's screen,
// so nothing above it (sheet, signatures, folios) applies.
function ebookSection(ctx: PanelContext): HTMLElement {
  const status = el("div", "export-status");
  status.setAttribute("aria-live", "polite");
  const btn = el("button", "tog outline", "Export EPUB");
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
  const sheets = (n: number) => `${n} sheet${n === 1 ? "" : "s"}`;
  if (isTrueFold(setup.fold)) {
    const times = TRUE_FOLDS[setup.fold].folds.length;
    line(
      `${FOLD_LABELS[setup.fold]} on ${setup.sheet}: folded ${
        ["once", "twice", "three times"][times - 1]
      }, ${2 * setup.nUp} pages a sheet, no cuts`,
    );
    if (times > 1) {
      line(
        `Slit the folds at the ${
          times > 2 ? "head and fore edge" : "head"
        } before sewing`,
      );
    }
  } else if (setup.fold === "leaves") {
    line(
      `${setup.nUp}-up on ${setup.sheet}: ${setup.nUp} leaves a sheet, ${setup.cutsPerSheet} cut${
        setup.cutsPerSheet === 1 ? "" : "s"
      }, no folds`,
    );
    line(
      pageCount
        ? `${sheets(setup.sheetsPerSignature)} for ${pageCount} pages`
        : "Sheets counted once the preview has paginated",
    );
  } else {
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
  }
  if (setup.fold !== "leaves") {
    const nested = isTrueFold(setup.fold) && setup.sheetsPerSignature > 1
      ? " nested"
      : "";
    if (setup.booklet && !pageCount) {
      line("Booklet: sized once the preview has paginated");
    } else if (setup.booklet) {
      line(
        `Booklet: all ${pageCount} pages in one ${setup.folios}-folio signature, ${
          sheets(setup.sheetsPerSignature)
        }${nested}`,
      );
    } else {
      line(
        `${
          sheets(setup.sheetsPerSignature)
        }${nested} per ${setup.folios}-folio signature = ${setup.pagesPerSignature} book pages`,
      );
    }
  }
  const EPS = 5e-4;
  if (setup.slackAcross > EPS || setup.slackDown > EPS) {
    line(
      `Leftover paper: ${fmtLength(setup.slackAcross, setup.unit)} across, ${
        fmtLength(setup.slackDown, setup.unit)
      } down, trimmed off${setup.fold === "leaves" ? "" : " after folding"}`,
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
  const { origin: o, cell } = imp;
  const folded = isTrueFold(imp.fold);
  // Grid lines: a folded sheet folds at every cell edge; loose leaves cut at
  // every one; a cut sheet folds each column pair and cuts the rest.
  const lines: Array<
    { cls: string; x1: number; y1: number; x2: number; y2: number }
  > = [];
  for (let c = 1; c < imp.cols; c++) {
    const x = o.x + c * cell.w;
    const cls = folded || (imp.fold === "cut" && c % 2) ? "fold" : "cut";
    lines.push({ cls, x1: x, x2: x, y1: o.y, y2: o.y + imp.rows * cell.h });
  }
  for (let r = 1; r < imp.rows; r++) {
    const y = o.y + r * cell.h;
    lines.push({
      cls: folded ? "fold" : "cut",
      x1: o.x,
      x2: o.x + imp.cols * cell.w,
      y1: y,
      y2: y,
    });
  }
  const side = (slots: Slot[], label: string) => {
    const s = svg("svg", {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `${label}: pages ${
        slots.map((t) => t.page === null ? "blank" : t.page + 1).join(", ")
      }`,
    }, svg("rect", { class: "paper", width: W, height: H }));
    for (const slot of slots) {
      s.append(svg("rect", {
        class: slot.page === null ? "slot blank" : "slot",
        x: slot.x,
        y: slot.y,
        width: pw,
        height: ph,
      }));
      if (slot.page === null) continue;
      const cx = slot.x + pw / 2;
      const cy = slot.y + ph / 2;
      s.append(svg("text", {
        x: cx,
        y: cy,
        "font-size": Math.min(pw, ph) * 0.4,
        transform: slot.rotate ? `rotate(180 ${cx} ${cy})` : "",
      }, String(slot.page + 1)));
    }
    for (const { cls, ...at } of lines) {
      s.append(svg("line", { class: cls, ...at }));
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
  const how = folded
    ? `Fold ${
      TRUE_FOLDS[imp.fold as keyof typeof TRUE_FOLDS].folds.map((f) =>
        f === "v"
          ? "the left half back behind the right"
          : "the top half back behind the bottom"
      ).join(", then ")
    }, printed front facing you.${
      imp.sheetsPerSignature > 1
        ? " Nest each signature's folded sheets in order, sheet 1 outermost."
        : ""
    }`
    : imp.fold === "leaves"
    ? "Solid lines cut. Cut the stack and pile the pieces in reading order, top row first."
    : setup.cutsPerSheet
    ? "Dashed lines fold, solid lines cut."
    : "Dashed lines fold.";
  const notes = [
    more > 0 ? `And ${more} more sheet${more === 1 ? "" : "s"}.` : "",
    how,
    first.some((sh) => [...sh.front, ...sh.back].some((t) => t.rotate))
      ? "Upside-down numbers print upside down, which is how the sheet lines up."
      : "",
  ];
  host.append(el("p", "hint", notes.filter(Boolean).join(" ")));
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
