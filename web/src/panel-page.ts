// web/src/panel-page.ts — the style panel's Page and Print tabs (spec R1).
// Page: trim size, margins, page numbers, running heads. Print: the sheet,
// signatures and the imposition they derive to (§4.3), the first signature
// drawn as it prints (R7), and the print export. Both write the `page`
// section; Print reads the trim size the Page tab set.
import type {
  CssProps,
  Duplex,
  Flip,
  NumberingStyle,
  PageConfig,
  Running,
  RunningEntry,
} from "../../metadata/types.ts";
import {
  DEFAULT_SIZE,
  fmtLength,
  formatCssLines,
  isValidFolios,
  isValidSize,
  makeRunningEntry,
  MARGIN_AREAS,
  PAGE_SIZE_PRESETS,
  parseCssLines,
  parseLength,
  presetFor,
  resolvePageSetup,
  RUNNING_CONTENT_CHOICES,
  runningSummary,
  setRunningShared,
  SHEET_PRESETS,
  type SizePreset,
  splitRunningEntry,
  tryParseDims,
} from "./config-data.ts";
import {
  field,
  fontControl,
  selectInput,
  textInputRaw,
} from "./config-panel.ts";
import {
  icon,
  makeView,
  moreCss,
  row,
  section,
  seg,
  select,
  stepper,
  toggle,
  type View,
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
  // Every save in this tab, advanced running heads included, repaints the dots.
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
    ]),
    pageNumbers(ctx, v),
    runningHeads(ctx, v),
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

// Font alias segments (Body / Display / …); clicking the lit one unsets it.
function fontSeg(
  ctx: PanelContext,
  value: string | undefined,
  onChange: (v: string | undefined) => void,
  label: string,
): HTMLElement {
  return seg(
    Object.keys(ctx.meta.fonts ?? {}).map((a) => ({
      value: a,
      label: a[0]!.toUpperCase() + a.slice(1),
    })),
    value,
    onChange,
    label,
    true,
  );
}

const NUMERALS = [
  { label: "i, ii, iii", value: "roman-lower" },
  { label: "I, II, III", value: "roman-upper" },
  { label: "1, 2, 3", value: "arabic" },
  { label: "Hidden", value: "hidden" },
];

const ZONES = [
  ["front-matter", "Front matter"],
  ["body", "Body"],
  ["back-matter", "Back matter"],
] as const;

function pageNumbers(ctx: PanelContext, view: View): HTMLElement {
  const numbering = ctx.meta.numbering ??= {};
  const live = () => numbering.pages; // the dots read the current value
  // Read-only snapshot — must not eagerly create numbering.pages[zone], or an
  // edit to one zone would persist a spurious empty sibling on save, since the
  // whole "numbering" section round-trips together.
  const pages = numbering.pages ?? {};
  const css: CssProps = pages.css ?? {};
  const setCss = (prop: string, v: string | undefined) => {
    const p = numbering.pages ??= {};
    const c = p.css ??= {};
    if (v) c[prop] = v;
    else delete c[prop];
    if (!Object.keys(c).length) delete p.css; // leave no empty css behind
    ctx.queueSave("numbering");
  };
  // "More CSS" hands back every prop without a control; swap those in.
  const putOthers = (
    holder: { css?: CssProps },
    controlled: string[],
    next: CssProps,
  ) => {
    const c = holder.css ?? {};
    for (const k of Object.keys(c)) if (!controlled.includes(k)) delete c[k];
    Object.assign(c, next);
    if (Object.keys(c).length) holder.css = c;
    else delete holder.css;
    ctx.queueSave("numbering");
  };
  const FOLIO = ["font-size", "font-family", "font-style"];
  const zones = ZONES.map(([zone, label]) => {
    const cfg = pages[zone] ?? {};
    const current = cfg.show === false || cfg.style === "none"
      ? "hidden"
      : cfg.style ?? "arabic";
    const options = NUMERALS.some((o) => o.value === current)
      ? NUMERALS
      : [...NUMERALS, { label: current, value: current }]; // e.g. alpha-upper
    return view.mark(
      row(
        label,
        select(options, current, (v) => {
          const z = (numbering.pages ??= {})[zone] ??= {};
          if (v === "hidden") z.show = false;
          else {
            z.style = v as NumberingStyle;
            z.show = true;
          }
          ctx.queueSave("numbering");
        }, `${label} page numbers`),
      ),
      () => {
        const z = live()?.[zone];
        return z?.style !== undefined || z?.show !== undefined;
      },
    );
  });
  return section("Page numbers", "folios", [
    view.mark(
      row(
        "Size",
        stepper({
          value: css["font-size"],
          // A margin box inherits nothing: unset shows no number.
          label: "Page number size",
          onChange: (v) => setCss("font-size", v),
        }),
      ),
      () => !!live()?.css?.["font-size"],
    ),
    view.mark(
      row(
        "Font",
        fontSeg(
          ctx,
          css["font-family"],
          (v) => setCss("font-family", v),
          "Page number font",
        ),
      ),
      () => !!live()?.css?.["font-family"],
    ),
    view.mark(
      row(
        "Style",
        toggle(
          "Italic",
          css["font-style"] === "italic",
          (on) => setCss("font-style", on ? "italic" : undefined),
        ),
      ),
      () => !!live()?.css?.["font-style"],
    ),
    ...zones,
    moreCss("More CSS for page numbers", css, (next) => {
      if (!Object.keys(next).length && !numbering.pages?.css) return;
      putOthers(numbering.pages ??= {}, FOLIO, next);
      if (!Object.keys(numbering.pages).length) delete numbering.pages;
    }, FOLIO),
    ...ZONES.map(([zone, label]) =>
      moreCss(
        `More CSS for ${label.toLowerCase()} page numbers`,
        pages[zone]?.css ?? {},
        (next) => {
          const p = numbering.pages;
          if (!Object.keys(next).length && !p?.[zone]?.css) return;
          const z = (numbering.pages ??= {})[zone] ??= {};
          putOthers(z, [], next);
          const all = numbering.pages!;
          if (!Object.keys(z).length) delete all[zone];
          if (!Object.keys(all).length) delete numbering.pages;
        },
        [],
      )
    ),
  ], el("span", "from", "Bottom center"));
}

const HEADS = [
  { label: "Chapter title", value: "chapter-title" },
  { label: "Book title", value: "book-title" },
  { label: "Part title", value: "part-title" },
  { label: "Nothing", value: "none" },
];

function runningHeads(ctx: PanelContext, view: View): HTMLElement {
  const running = ctx.meta.running ??= {};
  const now = () => runningSummary(running);
  const simple = document.createElement("div");
  const summary = document.createElement("span");
  const advanced = advancedHeads(ctx, running, () => {
    drawSimple();
    drawSummary();
  });
  const details = el(
    "details",
    "more",
    el("summary", "", icon("chevR"), summary),
    el(
      "p",
      "hint",
      "Place heads in any of the 16 margin areas, add more than one per page, or give each its own CSS.",
    ),
    advanced.el,
  );
  // An edit in the advanced editor can change what the simple view shows.
  details.addEventListener("change", () => {
    drawSimple();
    drawSummary();
  });

  const drawSummary = () => {
    const all = [...(running.odd ?? []), ...(running.even ?? [])];
    const areas = [...new Set(all.map((e) => e.area))].join(", ");
    summary.textContent = `Layout: ${all.length} head${
      all.length === 1 ? "" : "s"
    }${areas ? `, ${areas}` : ""}`;
  };

  // Simple edits rebuild the advanced rows so they never show stale values.
  const changed = () => {
    ctx.queueSave("running");
    advanced.render();
    drawSummary();
  };

  const sideRow = (side: "odd" | "even", label: string, current: string) => {
    const options = HEADS.some((o) => o.value === current)
      ? HEADS
      : [...HEADS, {
        label: current === "page-number" ? "Page number" : `“${current}”`,
        value: current,
      }];
    return view.mark(
      row(
        label,
        select(options, current, (v) => {
          const entries = running[side] ??= [];
          if (entries[0]) entries[0].content = v;
          else {
            // First head on this side: mirror the other side's styling.
            const other = running[side === "odd" ? "even" : "odd"]?.[0];
            entries.push({
              ...other,
              content: v,
              area: side === "odd" ? "top-right" : "top-left",
            });
          }
          changed();
        }, `${label.replace(" pages", " page")} running head`),
      ),
      () => !!running[side]?.length,
    );
  };

  // "mixed": the entries disagree; the note stays until the control is used.
  const mixed = (r: HTMLElement, isMixed: boolean) => {
    if (!isMixed) return r;
    const ctl = r.querySelector(".ctl")!;
    const note = el("span", "from", "Mixed");
    ctl.append(note);
    ctl.addEventListener("change", () => note.remove());
    ctl.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button")) note.remove();
    });
    return r;
  };

  const drawSimple = () => {
    const s = runningSummary(running);
    const shared = (
      prop: "font-size" | "font-style" | "font-family",
      v: string | undefined,
    ) => {
      setRunningShared(running, prop, v);
      changed();
    };
    simple.replaceChildren(
      sideRow("even", "Left pages", s.left),
      sideRow("odd", "Right pages", s.right),
      mixed(
        view.mark(
          row(
            "Size",
            stepper({
              value: s.size === "mixed" ? undefined : s.size,
              placeholder: "8pt",
              label: "Running head size",
              onChange: (v) => shared("font-size", v),
            }),
          ),
          () => !!now().size && now().size !== "mixed",
        ),
        s.size === "mixed",
      ),
      mixed(
        view.mark(
          row(
            "Font",
            fontSeg(
              ctx,
              s.font === "mixed" ? undefined : s.font,
              (v) => shared("font-family", v),
              "Running head font",
            ),
          ),
          () => !!now().font && now().font !== "mixed",
        ),
        s.font === "mixed",
      ),
      mixed(
        view.mark(
          row(
            "Style",
            toggle(
              "Italic",
              s.italic === true,
              (on) => shared("font-style", on ? "italic" : undefined),
            ),
          ),
          () => now().italic === true,
        ),
        s.italic === "mixed",
      ),
    );
  };

  drawSimple();
  drawSummary();
  return section("Running heads", "heads", [simple, details]);
}

const AREA_CHOICES = MARGIN_AREAS.map((a) => ({ label: a, value: a }));
const LITERAL = "__literal"; // select sentinel for "type your own text"

// The full running-head editor: any number of entries per side, all 16 margin
// areas, raw CSS. `onEdit` fires after an entry is added or removed.
function advancedHeads(
  ctx: PanelContext,
  running: Running,
  onEdit: () => void,
): { el: HTMLElement; render: () => void } {
  const { meta, queueSave } = ctx;
  const wrap = document.createElement("div");
  const renders: Array<() => void> = [];

  for (const side of ["odd", "even"] as const) {
    const head = document.createElement("div");
    head.className = "cfg-field";
    const title = document.createElement("span");
    title.className = "cfg-label";
    title.textContent = `${side} pages`;
    const add = document.createElement("button");
    add.textContent = "+ entry";
    head.append(title, add);
    const list = document.createElement("div");

    const render = (): void => {
      list.innerHTML = "";
      (running[side] ?? []).forEach((_, i) => list.appendChild(entryRow(i)));
    };

    const entryRow = (i: number): HTMLElement => {
      const entries = running[side]!;
      const form = splitRunningEntry(entries[i]!);
      const commit = () => {
        entries[i] = makeRunningEntry(form);
        queueSave("running");
      };
      const row = document.createElement("div");
      row.className = "cfg-entry";

      const isChoice = (RUNNING_CONTENT_CHOICES as readonly string[]).includes(
        form.content,
      );
      // Raw (non-trimming): a literal running-header string may legitimately
      // need a leading/trailing space to control spacing against an adjacent
      // margin-box element (same rationale as numbering prefix/suffix).
      const literal = textInputRaw(isChoice ? "" : form.content, (v) => {
        form.content = v;
        commit();
      });
      literal.placeholder = "literal text";
      literal.hidden = isChoice;
      const contentSel = selectInput(
        [
          ...RUNNING_CONTENT_CHOICES.map((c) => ({ label: c, value: c })),
          { label: "literal…", value: LITERAL },
        ],
        isChoice ? form.content : LITERAL,
        (v) => {
          literal.hidden = v !== LITERAL;
          form.content = v === LITERAL ? literal.value : v;
          commit();
        },
      );

      const areaSel = selectInput(AREA_CHOICES, form.area, (v) => {
        form.area = v;
        commit();
      });

      const css = document.createElement("textarea");
      css.rows = 2;
      css.value = form.extraCss;
      css.placeholder = "font-size: 8pt\nfont-style: italic";

      // The margin box inherits nothing from the book body, so its font has to
      // be set here. Same picker as the Styles panel, writing font-family into
      // the same extra-css blob the textarea shows.
      const setFont = (v: string) => {
        const extras = parseCssLines(form.extraCss);
        if (v) extras["font-family"] = v;
        else delete extras["font-family"];
        form.extraCss = formatCssLines(extras);
        css.value = form.extraCss;
        commit();
      };
      const font = fontControl(
        meta,
        parseCssLines(form.extraCss)["font-family"],
        setFont,
        "browser default",
      );

      css.oninput = () => {
        form.extraCss = css.value;
        commit();
      };
      // On blur, rebuild the rows so the font picker reflects a font-family
      // typed straight into the textarea.
      css.onchange = () => render();

      const rm = document.createElement("button");
      rm.textContent = "✕ remove entry";
      rm.onclick = () => {
        entries.splice(i, 1);
        queueSave("running");
        render(); // indices shifted — rebuild the rows
        onEdit();
      };

      row.append(
        field("content", contentSel, literal),
        field("area", areaSel),
        field("font", font),
        field("extra css", css),
        rm,
      );
      return row;
    };

    add.onclick = () => {
      const entries = running[side] ??= [];
      // Sensible seed per §4.8's example: outer top corner of the spread.
      const seed: RunningEntry = {
        content: "book-title",
        area: side === "odd" ? "top-right" : "top-left",
      };
      entries.push(seed);
      queueSave("running");
      render();
      onEdit();
    };

    render();
    renders.push(render);
    wrap.append(head, list);
  }
  return { el: wrap, render: () => renders.forEach((r) => r()) };
}
