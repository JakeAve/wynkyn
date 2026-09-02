// web/src/style-panel.ts — the "Styles" section of the config panel (spec
// §7.4, tiers 1–2): pick any stylable element, edit the handful of CSS
// properties a typesetter touches, plus a "more CSS" list for the rest.
import type { Metadata } from "../../metadata/types.ts";
import {
  checkboxInput,
  field,
  sectionBox,
  selectInput,
  textInput,
} from "./config-panel.ts";
import { CURATED_PROPS, splitProps } from "./config-data.ts";
import { catalogFor, ensureProps, getProps } from "./style-catalog.ts";

export interface StyleSection {
  el: HTMLDetailsElement;
  select(key: string): void; // open the section and show this entry's form
}

const INHERIT = "";
const OTHER = "__other";
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

export function buildStyleSection(
  meta: Metadata,
  queueSave: (key: keyof Metadata) => void,
  initialKey?: string,
): StyleSection {
  const box = sectionBox("Styles");
  const catalog = catalogFor(meta);
  const byKey = new Map(catalog.map((e) => [e.key, e]));
  let current = byKey.get(initialKey ?? "") ?? catalog[0]!;

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
  picker.onchange = () => {
    current = byKey.get(picker.value)!;
    renderForm();
  };
  box.appendChild(field("element", picker));

  const form = document.createElement("div");
  box.appendChild(form);

  function renderForm(): void {
    form.innerHTML = "";
    const entry = current;
    const props = getProps(meta, entry);
    const { extra } = splitProps(props);
    // Write-through: mutate the live object and save; empty deletes the key.
    const set = (prop: string, value: string) => {
      const live = ensureProps(meta, entry);
      if (value) live[prop] = value;
      else delete live[prop];
      queueSave(entry.section);
    };

    form.append(
      field(
        "font",
        fontControl(meta, props["font-family"], (v) => set("font-family", v)),
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
  return {
    el: box,
    select(key) {
      const e = byKey.get(key);
      if (!e) return;
      current = e;
      picker.value = key;
      renderForm();
      box.open = true;
      box.scrollIntoView({ block: "start" });
    },
  };
}

function placeholder(input: HTMLInputElement, text: string): HTMLInputElement {
  input.placeholder = text;
  return input;
}

// Font alias picker with an escape hatch for a literal family name.
export function fontControl(
  meta: Metadata,
  value: string | undefined,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cfg-row";
  const aliases = Object.keys(meta.fonts ?? {});
  const isAlias = !value || aliases.includes(value);
  const other = textInput(isAlias ? "" : value, onChange);
  other.placeholder = "Georgia, serif";
  other.hidden = isAlias;
  const sel = selectInput(
    [
      { label: "(inherit)", value: INHERIT },
      ...aliases.map((a) => ({ label: a, value: a })),
      { label: "other…", value: OTHER },
    ],
    isAlias ? (value ?? INHERIT) : OTHER,
    (v) => {
      other.hidden = v !== OTHER;
      if (v !== OTHER) onChange(v);
      else other.focus();
    },
  );
  wrap.append(sel, other);
  return wrap;
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
