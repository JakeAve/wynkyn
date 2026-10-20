// web/src/panel-page.ts — the style panel's Page and Print tabs (spec R1).
// Page: trim size, margins, page numbers, running heads. Print: the sheet,
// signatures and the imposition they derive to (§4.3). Both write the `page`
// section; Print reads the trim size the Page tab set.
import type {
  CssProps,
  Duplex,
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
  row,
  section,
  seg,
  select,
  stepper,
  toggle,
  type View,
} from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";

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
  const v = makeView(ctx, () => showSetup(page, readout));
  const save = () => v.changed("page");
  showSetup(page, readout);
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
              { label: "Separate files", value: "none" },
            ],
            page.duplex ?? "short-edge",
            (d) => {
              if (d) page.duplex = d;
              save();
            },
            "Duplex",
          ),
        ),
        () => !!page.duplex,
      ),
    ]),
    section("Signatures", "folios-per-signature", [
      v.mark(
        row(
          "Folios each",
          stepper({
            value: page["folios-per-signature"]?.toString(),
            placeholder: "4",
            label: "Folios per signature",
            onChange: (n) => {
              if (n === undefined) delete page["folios-per-signature"];
              else if (isValidFolios(n)) {
                page["folios-per-signature"] = Number(n);
              } else return false; // 0 or a fraction: show the saved value
              save();
            },
          }),
        ),
        () => page["folios-per-signature"] !== undefined,
      ),
      readout,
    ]),
    el(
      "p",
      "tip",
      "Run a proof export first on a new printer and fold one signature by hand.",
    ),
  ];
}

// The derived half of the setup: what these values actually produce on paper.
function showSetup(page: PageConfig, readout: HTMLElement): void {
  const setup = resolvePageSetup(page);
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
  line(
    `${setup.sheetsPerSignature} sheet${
      setup.sheetsPerSignature === 1 ? "" : "s"
    } per ${setup.folios}-folio signature = ${setup.pagesPerSignature} book pages`,
  );
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
  const zones = ([
    ["front-matter", "Front matter"],
    ["body", "Body"],
    ["back-matter", "Back matter"],
  ] as const).map(([zone, label]) => {
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
          placeholder: "9pt",
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
