// web/src/panel-parts.ts — the style panel's Book parts tab (spec R1): the
// element picker over the style catalog (spec §7.4, tiers 1–2), chapter and
// part numbering, and note placement.
import type { Metadata, NumberingStyle } from "../../metadata/types.ts";
import {
  checkboxInput,
  field,
  fontControl,
  inlineLabel,
  selectInput,
  textInput,
  textInputRaw,
} from "./config-panel.ts";
import { CURATED_PROPS, NUMBERING_STYLES, splitProps } from "./config-data.ts";
import { section } from "./panel-controls.ts";
import {
  bookParts,
  catalogFor,
  ensureProps,
  getProps,
  inheritedFont,
  type PanelContext,
  routeFor,
} from "./style-catalog.ts";

const INHERIT = "";
const COMMON_PROPS = [
  ...CURATED_PROPS,
  "line-height",
  "color",
  "text-indent",
  "margin-left",
  "margin-right",
  "padding-left",
  "border-left",
  "border-bottom",
  "content",
  "vertical-align",
  "word-spacing",
  "display",
  "order",
  "opacity",
  "font-variant",
  "width",
];

// The picked entry outlives a tab switch or refresh() (both rebuild the tab).
let picked: string | undefined;

// `key` is the exact entry a preview click chose (selectStyle); without it
// the picker stays on its last entry, or the part's first when that left.
export function buildPartsTab(
  ctx: PanelContext,
  part?: string,
  key?: string,
): Node[] {
  const { meta } = ctx;
  // Running-head entries point at the whole `running` section — editing one
  // here would write stray props onto metadata.running. The Page tab owns them.
  const catalog = catalogFor(meta).filter((e) => e.section !== "running");
  const byKey = new Map(catalog.map((e) => [e.key, e]));
  const keys = part
    ? bookParts(meta).find((p) => p.id === part)?.keys ?? []
    : [];
  if (key && byKey.has(key)) picked = key;
  else if (keys.length && !keys.includes(picked ?? "")) picked = keys[0];
  let current = byKey.get(picked ?? "") ?? catalog[0]!;

  // Picker: one optgroup per catalog group, in catalog order.
  const picker = document.createElement("select");
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const e of catalog) {
    let g = groups.get(e.group);
    if (!g) {
      g = document.createElement("optgroup");
      g.label = e.group;
      groups.set(e.group, g);
      picker.appendChild(g);
    }
    g.appendChild(new Option(e.label, e.key, false, e.key === current.key));
  }
  const form = document.createElement("div");
  // data-focus follows the picked entry so a routed pick flashes this section.
  const box = section("Styles", "styles", [field("element", picker), form]);
  picker.onchange = () => {
    current = byKey.get(picker.value)!;
    picked = current.key;
    renderForm();
  };

  function renderForm(): void {
    box.dataset.focus = routeFor(current.key, meta).focus ?? "styles";
    form.innerHTML = "";
    const entry = current;
    const props = getProps(meta, entry);
    const { extra } = splitProps(props);
    // Write-through: mutate the live object and save; empty deletes the key.
    const set = (prop: string, value: string) => {
      const live = ensureProps(meta, entry);
      if (value) live[prop] = value;
      else delete live[prop];
      ctx.queueSave(entry.section);
    };
    form.append(
      field(
        "font",
        fontControl(
          meta,
          props["font-family"],
          (v) => set("font-family", v),
          inheritedFont(meta, entry),
        ),
      ),
      field(
        "size",
        placeholder(
          textInput(props["font-size"] ?? "", (v) => set("font-size", v)),
          "11pt",
        ),
      ),
      field(
        "weight",
        selectInput(
          [{ label: "(inherit)", value: INHERIT }, {
            label: "normal",
            value: "normal",
          }, { label: "bold", value: "bold" }],
          props["font-weight"] ?? INHERIT,
          (v) => set("font-weight", v),
        ),
      ),
      field(
        "italic",
        checkboxInput(
          props["font-style"] === "italic",
          (on) => set("font-style", on ? "italic" : ""),
        ),
      ),
      field(
        "align",
        selectInput(
          [INHERIT, "left", "center", "right", "justify"].map((v) => ({
            label: v || "(inherit)",
            value: v,
          })),
          props["text-align"] ?? INHERIT,
          (v) => set("text-align", v),
        ),
      ),
      field(
        "letter-spacing",
        placeholder(
          textInput(
            props["letter-spacing"] ?? "",
            (v) => set("letter-spacing", v),
          ),
          "0.08em",
        ),
      ),
      field(
        "transform",
        selectInput(
          [INHERIT, "uppercase", "lowercase", "capitalize", "none"].map((
            v,
          ) => ({ label: v || "(inherit)", value: v })),
          props["text-transform"] ?? INHERIT,
          (v) => set("text-transform", v),
        ),
      ),
      field(
        "space above",
        placeholder(
          textInput(props["margin-top"] ?? "", (v) => set("margin-top", v)),
          "30pt",
        ),
      ),
      field(
        "space below",
        placeholder(
          textInput(
            props["margin-bottom"] ?? "",
            (v) => set("margin-bottom", v),
          ),
          "30pt",
        ),
      ),
      moreCss(extra, set),
    );
  }

  renderForm();
  return [box, numberingSection(meta, ctx.queueSave), notesSection(ctx)];
}

const STYLE_CHOICES = NUMBERING_STYLES.map((s) => ({ label: s, value: s }));

function numberingSection(
  meta: Metadata,
  queueSave: PanelContext["queueSave"],
): HTMLElement {
  const numbering = meta.numbering ??= {};
  const kids: HTMLElement[] = [];
  // Read-only snapshots for display — must not eagerly create
  // numbering.chapters/parts, or an edit to one of them (e.g. chapters.style)
  // would persist a spurious empty sibling (e.g. parts: {}) on save, since the
  // whole "numbering" section round-trips together.
  for (const key of ["chapters", "parts"] as const) {
    const cfg = numbering[key] ?? {};
    kids.push(
      field(
        key,
        selectInput(STYLE_CHOICES, cfg.style ?? "arabic", (v) => {
          (numbering[key] ??= {}).style = v as NumberingStyle;
          queueSave("numbering");
        }),
        inlineLabel(
          "show",
          checkboxInput(cfg.show ?? true, (v) => {
            (numbering[key] ??= {}).show = v;
            queueSave("numbering");
          }),
        ),
      ),
      field(
        `${key} prefix`,
        textInputRaw(cfg.prefix ?? "", (v) => {
          (numbering[key] ??= {}).prefix = v;
          queueSave("numbering");
        }),
      ),
      field(
        `${key} suffix`,
        textInputRaw(cfg.suffix ?? "", (v) => {
          (numbering[key] ??= {}).suffix = v;
          queueSave("numbering");
        }),
      ),
    );
  }
  return section("Numbering", "numbering", kids);
}

function notesSection(ctx: PanelContext): HTMLElement {
  const notes = ctx.meta.notes ??= {};
  return section("Notes", "notes", [
    field(
      "placement",
      selectInput(
        [
          { label: "footnote — bottom of the page", value: "footnote" },
          { label: "endnote — end of chapter/matter", value: "endnote" },
        ],
        notes.placement ?? "footnote",
        (v) => {
          notes.placement = v as "footnote" | "endnote";
          ctx.queueSave("notes");
        },
      ),
    ),
  ]);
}

function placeholder(input: HTMLInputElement, text: string): HTMLInputElement {
  input.placeholder = text;
  return input;
}

// Key/value rows for properties outside the curated set. Commit on change;
// a blank key or value removes the property.
function moreCss(
  extra: Record<string, string>,
  set: (prop: string, value: string) => void,
): HTMLElement {
  const details = document.createElement("details");
  details.className = "cfg-more";
  const summary = document.createElement("summary");
  summary.className = "caption";
  const n = Object.keys(extra).length;
  summary.textContent = n ? `More CSS (${n})` : "More CSS";
  details.appendChild(summary);
  const dl = document.createElement("datalist");
  dl.id = "css-prop-list";
  for (const p of COMMON_PROPS) dl.appendChild(new Option(p, p));
  details.appendChild(dl);
  const rows = document.createElement("div");
  details.appendChild(rows);

  function row(prop: string, value: string): HTMLElement {
    const r = document.createElement("div");
    r.className = "cfg-field";
    const k = document.createElement("input");
    k.type = "text";
    k.value = prop;
    k.placeholder = "property";
    k.setAttribute("list", "css-prop-list");
    k.setAttribute("aria-label", "css property");
    const v = document.createElement("input");
    v.type = "text";
    v.value = value;
    v.placeholder = "value";
    v.setAttribute("aria-label", "css value");
    let committed = prop;
    const commit = () => {
      const key = k.value.trim();
      const val = v.value.trim();
      if (committed && committed !== key) set(committed, ""); // renamed or cleared
      if (key && val) set(key, val);
      committed = key && val ? key : "";
    };
    k.onchange = commit;
    v.onchange = commit;
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.setAttribute("aria-label", `remove ${prop || "property"}`);
    rm.onclick = () => {
      if (committed) set(committed, "");
      r.remove();
    };
    r.append(k, v, rm);
    return r;
  }

  for (const [p, v] of Object.entries(extra)) rows.appendChild(row(p, v));
  const add = document.createElement("button");
  add.textContent = "+ property";
  add.onclick = () => {
    const r = row("", "");
    rows.appendChild(r);
    r.querySelector("input")?.focus();
  };
  details.appendChild(add);
  return details;
}
