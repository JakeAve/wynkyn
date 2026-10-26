// web/src/panel-furniture.ts — the Page furniture parts of the Book parts tab
// (UX round 1): page numbers and running heads. Each has where it sits, its
// gap from the text block (§4.7, §4.8), type, CSS, and the Chicago rules for
// the pages that drop it (renderer/folios.js) — read-only except the opener
// folio, which a book may drop or move (`numbering.pages.openers`).
import type {
  CssProps,
  FolioPosition,
  NumberingStyle,
  Running,
  RunningEntry,
} from "../../metadata/types.ts";
import {
  DEFAULT_FOLIO_GAP,
  DEFAULT_HEAD_GAP,
  MARGIN_AREAS,
} from "../../metadata/css-generator.ts";
import {
  formatCssLines,
  HEAD_AREAS,
  headPosition,
  makeRunningEntry,
  parseCssLines,
  RUNNING_CONTENT_CHOICES,
  runningSummary,
  setHeadPosition,
  setRunningShared,
  splitRunningEntry,
} from "./config-data.ts";
import {
  field,
  fontControl,
  selectInput,
  textInputRaw,
} from "./config-panel.ts";
import {
  applies,
  icon,
  makeView,
  moreCss,
  row,
  section,
  seg,
  select,
  stepper,
  switchInput,
  toggle,
  type View,
} from "./panel-controls.ts";
import { folioClash, type PanelContext } from "./style-catalog.ts";

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

export function buildFurniture(
  panel: PanelContext,
  part: "folios" | "heads",
): Node[] {
  // Every save in the part, advanced running heads included, repaints the dots.
  const v = makeView(panel);
  const ctx: PanelContext = { ...panel, queueSave: v.changed };
  return part === "folios" ? pageNumbers(ctx, v) : runningHeads(ctx, v);
}

// What the page map drops where (renderer/folios.js, Chicago). Read-only;
// the one override, the opener folio, has its own section above.
function dropped(rules: Array<[string, string]>): HTMLElement {
  return section("Where they're dropped", "dropped", [
    el(
      "ul",
      "rules",
      ...rules.map(([where, what]) =>
        el("li", "", el("span", "", where), el("span", "", what))
      ),
    ),
  ], el("span", "from", "Chicago"));
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

// ---- page numbers ----

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

// [position, slot class, name], in the order the slots sit on each page.
const POSITIONS: Array<[FolioPosition, string, string]> = [
  ["top-outside", "to", "Top outside"],
  ["top-center", "tc", "Top center"],
  ["bottom-outside", "bo", "Bottom outside"],
  ["bottom-center", "bc", "Bottom center"],
];

// A two-page spread, four slots a page; both pages light the chosen position.
// The slot the other furniture (page number or head) sits in is marked taken;
// `clash` says what to do when the two share a box on body pages.
function positionPicker(o: {
  at: () => FolioPosition | undefined;
  set: (pos: FolioPosition) => void;
  taken: () => FolioPosition | undefined;
  takenBy: string;
  clash: () => string | undefined;
  unset?: () => [name: string, note: string]; // what to say when `at` is undefined
  clear?: () => void; // clicking the lit slot unsets, when given
}): { nodes: HTMLElement[]; paint: () => void } {
  const name = el("b", "");
  const note = el("span", "");
  const clash = el("p", "hint");
  const slots: Array<[FolioPosition, HTMLButtonElement]> = [];
  const paint = () => {
    const at = o.at();
    const taken = o.taken();
    for (const [pos, b] of slots) {
      b.setAttribute("aria-pressed", String(pos === at));
      b.classList.toggle("taken", pos === taken);
      const label = POSITIONS.find(([p]) => p === pos)![2];
      b.title = pos === taken ? `${label} (${o.takenBy} here)` : label;
    }
    name.textContent = at
      ? POSITIONS.find(([p]) => p === at)![2]
      : o.unset?.()[0] ?? "";
    note.textContent = at ? "Mirrored on facing pages." : o.unset?.()[1] ?? "";
    const text = o.clash();
    clash.hidden = !text;
    clash.textContent = text ?? "";
  };
  const pageOf = (side: "v" | "r") =>
    el(
      "div",
      `pm ${side}`,
      ...POSITIONS.map(([pos, cls, label]) => {
        const b = el("button", `slot ${cls}`);
        b.type = "button";
        b.setAttribute(
          "aria-label",
          `${label}, ${side === "v" ? "left" : "right"} page`,
        );
        b.onclick = () => {
          if (o.clear && pos === o.at()) o.clear();
          else o.set(pos);
          paint();
        };
        slots.push([pos, b]);
        return b;
      }),
    );
  const picker = el(
    "div",
    "pospick",
    el("div", "spread-mini", pageOf("v"), pageOf("r")),
    el("div", "label", name, note),
  );
  paint();
  return { nodes: [picker, clash], paint };
}

function pageNumbers(ctx: PanelContext, view: View): HTMLElement[] {
  const numbering = ctx.meta.numbering ??= {};
  const live = () => numbering.pages; // the dots read the current value
  // Read-only snapshot — must not eagerly create numbering.pages[zone], or an
  // edit to one zone would persist a spurious empty sibling on save, since the
  // whole "numbering" section round-trips together.
  const pages = numbering.pages ?? {};
  const css: CssProps = pages.css ?? {};
  const tidy = () => {
    if (numbering.pages && !Object.keys(numbering.pages).length) {
      delete numbering.pages;
    }
  };
  const setCss = (prop: string, v: string | undefined) => {
    const p = numbering.pages ??= {};
    const c = p.css ??= {};
    if (v) c[prop] = v;
    else delete c[prop];
    if (!Object.keys(c).length) delete p.css; // leave no empty css behind
    tidy();
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

  // The default, bottom center, is stored as no key.
  const position = positionPicker({
    at: () => live()?.position ?? "bottom-center",
    set: (pos) => {
      const p = numbering.pages ??= {};
      if (pos === "bottom-center") delete p.position;
      else p.position = pos;
      tidy();
      ctx.queueSave("numbering");
    },
    taken: () => headPosition(ctx.meta.running),
    takenBy: "running head",
    clash: () => {
      const area = folioClash(
        live()?.position ?? "bottom-center",
        ctx.meta.running,
      );
      return area &&
        `A running head is set at ${area} too, so body pages show the head there instead of the number. Move one of them.`;
    },
  });

  // Chapter and part openers (§4.7): the folio can be dropped (the switch) or
  // moved, Chicago's drop folio. Both default to "as every other page".
  const openers = () => live()?.openers;
  const editOpeners = (
    f: (o: NonNullable<NonNullable<typeof numbering.pages>["openers"]>) => void,
  ) => {
    const p = numbering.pages ??= {};
    const o = p.openers ??= {};
    f(o);
    if (!Object.keys(o).length) delete p.openers;
    tidy();
    ctx.queueSave("numbering");
  };
  // Same picker as the Position sections; no slot lit means the opener's
  // number sits where every other page's does, and clicking the lit slot
  // goes back to that.
  const openerPosition = positionPicker({
    at: () => openers()?.position,
    set: (pos) => editOpeners((o) => o.position = pos),
    clear: () => editOpeners((o) => delete o.position),
    taken: () => undefined,
    takenBy: "",
    clash: () => undefined,
    unset: () => ["Same as other pages", ""],
  });
  const openerWhere = el("div", "", ...openerPosition.nodes);
  openerWhere.hidden = openers()?.show === false;
  const openerRows = [
    view.mark(
      row(
        "Page number",
        switchInput(
          "Page number on chapter and part openers",
          openers()?.show !== false,
          (on) => {
            editOpeners((o) => {
              if (on) delete o.show;
              else o.show = false;
            });
            openerWhere.hidden = !on;
          },
        ),
      ),
      () => openers()?.show === false,
    ),
    openerWhere,
  ];

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

  return [
    section("Position", "position", [
      ...position.nodes,
      view.mark(
        row(
          "Gap from text",
          stepper({
            value: pages.gap,
            placeholder: DEFAULT_FOLIO_GAP,
            label: "Gap between page number and text",
            onChange: (g) => {
              const p = numbering.pages ??= {};
              if (g) p.gap = g;
              else delete p.gap;
              tidy();
              ctx.queueSave("numbering");
            },
          }),
        ),
        () => !!live()?.gap,
      ),
    ], applies(ctx, "numbering.pages")),
    section("Numerals", "numerals", zones),
    section("Chapter and part openers", "openers", openerRows),
    section("Type", "type", [
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
      moreCss("More CSS for page numbers", css, (next) => {
        if (!Object.keys(next).length && !numbering.pages?.css) return;
        putOthers(numbering.pages ??= {}, FOLIO, next);
        tidy();
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
            tidy();
          },
          [],
        )
      ),
    ]),
    dropped([
      ["Blank pages", "No number"],
      [
        "Half title, title page, copyright and other display pages",
        "No number",
      ],
      ["Back matter", "Continues the body count"],
    ]),
  ];
}

// ---- running heads ----

const HEADS = [
  { label: "Chapter title", value: "chapter-title" },
  { label: "Book title", value: "book-title" },
  { label: "Part title", value: "part-title" },
  { label: "Nothing", value: "none" },
];

function runningHeads(ctx: PanelContext, view: View): HTMLElement[] {
  const running = ctx.meta.running ??= {};
  const now = () => runningSummary(running);
  const content = document.createElement("div");
  const type = document.createElement("div");
  const summary = document.createElement("span");
  const advanced = advancedHeads(ctx, running, () => {
    drawSimple();
    drawSummary();
    position.paint();
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
    position.paint();
  });

  const drawSummary = () => {
    const all = [...(running.odd ?? []), ...(running.even ?? [])];
    const areas = [...new Set(all.map((e) => e.area))].join(", ");
    summary.textContent = `More CSS and layout: ${all.length} head${
      all.length === 1 ? "" : "s"
    }${areas ? `, ${areas}` : ""}`;
  };

  // Simple edits rebuild the advanced rows so they never show stale values.
  const changed = () => {
    ctx.queueSave("running");
    advanced.render();
    drawSummary();
    position.paint();
  };

  const folioAt = () => ctx.meta.numbering?.pages?.position ?? "bottom-center";
  const position = positionPicker({
    at: () => headPosition(running),
    set: (pos) => {
      setHeadPosition(running, pos);
      changed();
    },
    taken: folioAt,
    takenBy: "page number",
    clash: () => {
      const area = folioClash(folioAt(), running);
      return area &&
        `The page number is set at ${area} too, so body pages show the head there instead of the number. Move one of them.`;
    },
    unset: () =>
      running.odd?.length || running.even?.length
        ? ["Custom", "Placed under More CSS and layout."]
        : ["No heads", "Choose what the heads say first."],
  });

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
            // First head on this side: mirror the other side's styling and
            // position.
            const other = running[side === "odd" ? "even" : "odd"]?.[0];
            const at = HEAD_AREAS[headPosition(running) ?? "top-outside"];
            entries.push({
              ...other,
              content: v,
              area: side === "odd" ? at[0] : at[1],
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
    content.replaceChildren(
      sideRow("even", "Left pages", s.left),
      sideRow("odd", "Right pages", s.right),
    );
    type.replaceChildren(
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
  return [
    section("Position", "position", [
      ...position.nodes,
      view.mark(
        row(
          "Gap from text",
          stepper({
            value: running.gap,
            placeholder: DEFAULT_HEAD_GAP,
            label: "Gap between running head and text",
            onChange: (g) => {
              if (g) running.gap = g;
              else delete running.gap;
              ctx.queueSave("running");
            },
          }),
        ),
        () => !!running.gap,
      ),
    ]),
    section("Content", "content", [content]),
    section("Type", "type", [type, details]),
    dropped([
      ["Blank and display pages", "No head"],
      ["Chapter and part openers", "No head"],
      ["Front and back matter", "No head"],
    ]),
  ];
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
