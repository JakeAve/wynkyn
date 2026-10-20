// web/src/panel-page.ts — the style panel's Page and Print tabs (spec R1).
// Page: trim size, margins, page numbers, running heads. Print: the sheet,
// signatures and the imposition they derive to (§4.3). Both write the `page`
// section; Print reads the trim size the Page tab set.
import type {
  Duplex,
  NumberingStyle,
  PageConfig,
  RunningEntry,
} from "../../metadata/types.ts";
import {
  fmtLength,
  formatCssLines,
  isValidFolios,
  isValidSize,
  makeRunningEntry,
  MARGIN_AREAS,
  PAGE_NUMBERING_STYLES,
  PAGE_SIZE_PRESETS,
  parseCssLines,
  presetFor,
  resolvePageSetup,
  RUNNING_CONTENT_CHOICES,
  SHEET_PRESETS,
  type SizePreset,
  splitRunningEntry,
} from "./config-data.ts";
import {
  checkboxInput,
  field,
  fontControl,
  inlineLabel,
  selectInput,
  textInput,
  textInputRaw,
} from "./config-panel.ts";
import { section } from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";

const MARGIN_KEYS = ["top", "bottom", "inside", "outside"] as const;

export function buildPageTab(ctx: PanelContext): Node[] {
  const { meta } = ctx;
  const page: PageConfig = meta.page ??= {};
  const trim = section("Trim size", "trim", [
    field(
      "page size",
      sizeControl(page.size, (size) => {
        page.size = size;
        ctx.queueSave("page");
      }),
    ),
  ]);
  // Read-only snapshot for display — must not eagerly create page.margins,
  // or an edit to an unrelated field (e.g. size) would persist a spurious
  // empty margins object on save (the whole "page" section round-trips
  // together, so any local default-filling here leaks onto disk).
  const margins = page.margins ?? {};
  const marginBox = section(
    "Margins",
    "margins",
    MARGIN_KEYS.map((key) =>
      field(
        `margin ${key}`,
        textInput(margins[key] ?? "", (v) => {
          const m = page.margins ??= {};
          if (v) m[key] = v;
          else delete m[key];
          ctx.queueSave("page");
        }),
      )
    ),
  );
  return [trim, marginBox, pageNumbers(ctx), runningHeads(ctx)];
}

export function buildPrintTab(ctx: PanelContext): Node[] {
  const page: PageConfig = ctx.meta.page ??= {};
  const readout = document.createElement("div");
  readout.className = "cfg-readout";
  const save = () => {
    ctx.queueSave("page");
    showSetup(page, readout);
  };

  const paper = section("Paper", "sheet", [
    field(
      "sheet",
      sizeControl(page.sheet, (sheet) => {
        page.sheet = sheet;
        save();
      }, SHEET_PRESETS),
    ),
    field(
      "duplex",
      selectInput(
        [
          { label: "short-edge — book-style turn", value: "short-edge" },
          { label: "long-edge — calendar-style turn", value: "long-edge" },
          { label: "none — separate fronts/backs files", value: "none" },
        ],
        page.duplex ?? "short-edge",
        (v) => {
          page.duplex = v as Duplex;
          save();
        },
      ),
    ),
  ]);

  const folioError = document.createElement("span");
  folioError.className = "cfg-error";
  const folios = textInput(
    String(page["folios-per-signature"] ?? ""),
    (v) => {
      if (isValidFolios(v)) {
        folioError.textContent = "";
        page["folios-per-signature"] = Number(v);
        save();
      } else {
        folioError.textContent = v ? "must be a positive integer" : "";
      }
    },
  );
  folios.placeholder = "4";
  const signatures = section("Signatures", "folios", [
    field("folios/signature", folios, folioError),
    readout,
  ]);
  showSetup(page, readout);
  return [paper, signatures];
}

// The derived half of the setup: what these values actually produce on paper.
function showSetup(page: PageConfig, readout: HTMLElement): void {
  const setup = resolvePageSetup(page);
  readout.textContent = "";
  readout.classList.toggle("cfg-readout-bad", setup.error !== null);
  const line = (text: string) => {
    const p = document.createElement("p");
    p.textContent = text;
    readout.appendChild(p);
  };
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
    `${setup.nUp}-up on ${setup.sheet}${grid} — ${setup.foliosPerSheet} ${folioWord} per sheet (${cuts})`,
  );
  if (setup.rows > 1) {
    line(
      `sheet prints ${
        setup.landscape ? "landscape" : "portrait"
      } — cut across, then fold each piece down its center`,
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
      `leftover paper: ${fmtLength(setup.slackAcross, setup.unit)} across, ${
        fmtLength(setup.slackDown, setup.unit)
      } down — trimmed off after folding`,
    );
  } else {
    line("the page tiles the sheet exactly — nothing to trim off");
  }
}

// Preset dropdown + custom-dimensions input (spec §7.5: named presets and
// custom dimensions), over either the book-page or the sheet preset list.
// Calls onChange only with valid values; invalid custom input shows an error.
function sizeControl(
  current: string | undefined,
  onChange: (size: string) => void,
  presets: SizePreset[] = PAGE_SIZE_PRESETS,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cfg-row";
  const preset = presetFor(current, presets);
  const custom = document.createElement("input");
  custom.type = "text";
  custom.placeholder = "5.5in 8.5in";
  custom.value = preset === "custom" ? (current ?? "") : "";
  custom.hidden = preset !== "custom";
  const error = document.createElement("span");
  error.className = "cfg-error";
  const sel = selectInput(
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

const PAGE_STYLE_CHOICES = PAGE_NUMBERING_STYLES.map((s) => ({
  label: s,
  value: s,
}));

function pageNumbers(ctx: PanelContext): HTMLElement {
  const numbering = ctx.meta.numbering ??= {};
  // Read-only snapshot — must not eagerly create numbering.pages[zone], or an
  // edit to one zone would persist a spurious empty sibling on save, since the
  // whole "numbering" section round-trips together.
  const pages = numbering.pages ?? {};
  return section(
    "Page numbers",
    "folios",
    (["front-matter", "body", "back-matter"] as const).map((zone) => {
      const cfg = pages[zone] ?? {};
      return field(
        `${zone} pages`,
        selectInput(PAGE_STYLE_CHOICES, cfg.style ?? "arabic", (v) => {
          ((numbering.pages ??= {})[zone] ??= {}).style = v as NumberingStyle;
          ctx.queueSave("numbering");
        }),
        inlineLabel(
          "show",
          checkboxInput(cfg.show ?? true, (v) => {
            ((numbering.pages ??= {})[zone] ??= {}).show = v;
            ctx.queueSave("numbering");
          }),
        ),
      );
    }),
  );
}

const AREA_CHOICES = MARGIN_AREAS.map((a) => ({ label: a, value: a }));
const LITERAL = "__literal"; // select sentinel for "type your own text"

function runningHeads(ctx: PanelContext): HTMLElement {
  const { meta } = ctx;
  const queueSave = ctx.queueSave;
  const running = meta.running ??= {};
  const kids: HTMLElement[] = [];

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
    };

    render();
    kids.push(head, list);
  }
  return section("Running heads", "heads", kids);
}
