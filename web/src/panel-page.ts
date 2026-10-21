// web/src/panel-page.ts — the style panel's Page and Print tabs (spec R1).
// Page: trim size and margins (page numbers and running heads are Page
// furniture parts, panel-furniture.ts). Print: the sheet,
// signatures and the imposition they derive to (§4.3), the first signature
// drawn as it prints (R7), and the print export. Both write the `page`
// section; Print reads the trim size the Page tab set.
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
  toggle,
} from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";
import { impose, type Slot } from "../../server/imposition.ts";
import type { PageSetup } from "../../metadata/page-setup.ts";

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

export function buildPrintTab(ctx: PanelContext): Node[] {
  const page: PageConfig = ctx.meta.page ??= {};
  const readout = el("div", "readout");
  const sheets = el("div", "sheets");
  // Redrawn on every edit and every repagination: a booklet's size and the
  // pages that land on each sheet both follow the book's page count.
  const redraw = () => {
    const pages = ctx.preview.pageCount();
    const setup = resolvePageSetup(page, { pageCount: pages || undefined });
    showSetup(setup, pages, readout);
    drawSignature(setup, pages, page.flip ?? "short-edge", sheets);
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
        "Backs",
        toggle("Last sheet first", page["reverse-backs"] === true, (on) => {
          if (on) page["reverse-backs"] = true;
          else delete page["reverse-backs"];
          save();
        }),
      ),
      () => page["reverse-backs"] === true,
    ),
    el(
      "p",
      "hint",
      "Print the fronts, turn the stack over on that edge and put it back in, then print the backs. Last sheet first suits printers that stack face up.",
    ),
  ];
  const showManual = () => {
    for (const m of manual) m.hidden = (page.duplex ?? "short-edge") !== "none";
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
          toggle("One signature", page[FPS] === "booklet", (on) => {
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
      sheets,
      readout,
    ]),
    exportSection(ctx, page),
  ];
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
  setup: PageSetup,
  pageCount: number,
  flip: Flip,
  host: HTMLElement,
): void {
  host.replaceChildren();
  if (setup.error !== null) return;
  const imp = impose(pageCount || setup.pagesPerSignature, {
    folios: setup.folios,
    sheet: setup.sheetDims,
    page: setup.page,
    duplex: setup.duplex,
    flip,
  });
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
