// web/src/panel-controls.ts — DOM controls for the style panel (rows, steppers,
// segments, toggles, selects, sections). Styled by the `#config-overlay` rules
// in index.html. DOM assembly only; length maths lives in config-data.ts.
import type { CssProps, Metadata } from "../../metadata/types.ts";
import {
  bumpLength,
  convertLength,
  formatCssLines,
  LENGTH_UNITS,
  parseCssLines,
  parseLength,
} from "./config-data.ts";
import type { PanelContext } from "./style-catalog.ts";

const ICONS = {
  minus: '<path d="M4 8h8"/>',
  plus: '<path d="M4 8h8M8 4v8"/>',
  chevR: '<path d="M6.5 4 10.5 8l-4 4"/>',
  chevD: '<path d="M4 6.5 8 10.5l4-4"/>',
  alignL: '<path d="M3 4h10M3 7h6M3 10h10M3 13h6"/>',
  alignC: '<path d="M3 4h10M5 7h6M3 10h10M5 13h6"/>',
  alignR: '<path d="M3 4h10M7 7h6M3 10h10M7 13h6"/>',
  alignJ: '<path d="M3 4h10M3 7h10M3 10h10M3 13h10"/>',
  reset: '<path d="M3.5 7.5a4.5 4.5 0 1 1 1.3 3.2"/><path d="M3.5 3.5v4h4"/>',
  pointer: '<path d="M4 2.5 12 8l-3.6.8L10.6 13l-1.5.7-2.2-4.2L4 12z"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.5M8 5.2v.1"/>',
};

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", "i");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name]; // constant strings above, never user input
  return s;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

// A view's "set" dots follow the values live: every write re-checks every mark.
export interface View {
  mark(r: HTMLElement, isSet: () => boolean): HTMLElement;
  changed(section: keyof Metadata): void;
}

// A row that was redrawn away (no longer in the document) drops out on the
// next write, so redraws don't pile up marks.
export function makeView(ctx: PanelContext, after = () => {}): View {
  let marks: Array<[HTMLElement, () => boolean]> = [];
  const paint = ([r, f]: [HTMLElement, () => boolean]) =>
    r.classList.toggle("set", f());
  return {
    mark(r, isSet) {
      marks.push([r, isSet]);
      paint([r, isSet]);
      return r;
    },
    changed(section) {
      ctx.queueSave(section);
      marks = marks.filter(([r]) => r.isConnected);
      marks.forEach(paint);
      after();
    },
  };
}

// Length field: takes and emits CSS lengths ("9pt"). The unit is shown beside
// the number and kept; empty means unset. `placeholder` is the inherited value.
// onChange returning false rejects the value: the field shows the old one.
// A bare non-zero number gets the field's unit — the value's or placeholder's,
// else `unit`, else "pt" — so a field whose value or placeholder is a bare
// number is a plain count and stays one. A negative is clamped to 0 unless
// `allowNegative`. `step` (counts) is read at each press, and a press lands on
// the next multiple of it.
export function stepper(o: {
  value: string | undefined;
  placeholder?: string;
  label: string;
  unit?: string;
  step?: () => number;
  allowNegative?: boolean;
  onChange(v: string | undefined): void | false;
}): HTMLElement {
  let value = o.value;
  let unit = parseLength(value ?? o.placeholder ?? "")?.unit ?? o.unit ?? "pt";
  const num = (v: string | undefined) => {
    const p = v === undefined ? null : parseLength(v);
    return p ? String(p.n) : "";
  };
  const input = h("input", {
    type: "text",
    inputmode: "decimal",
    "aria-label": o.label,
    autocomplete: "off",
  });
  // Plain counts keep a static label; lengths get a unit picker.
  const u = unit === "" ? h("span", { class: "u" }) : h("select", {
    class: "u",
    "aria-label": `${o.label} unit`,
    title: "Change unit",
  });
  const show = () => {
    input.value = num(value);
    input.placeholder = num(
      o.placeholder && convertLength(o.placeholder, unit),
    );
    if (!(u instanceof HTMLSelectElement)) return void (u.textContent = unit);
    u.replaceChildren(
      ...[...new Set([unit, ...LENGTH_UNITS])].map((x) =>
        new Option(x, x, false, x === unit)
      ),
    );
  };
  // Converts the value (or just the shown placeholder, when unset).
  u.onchange = () => {
    const to = (u as HTMLSelectElement).value;
    if (value === undefined) {
      unit = to;
      return show();
    }
    commit(convertLength(value, to));
  };
  const commit = (raw: string | undefined) => {
    const p0 = raw === undefined ? null : parseLength(raw);
    const n = p0 && !o.allowNegative ? Math.max(0, p0.n) : p0?.n;
    const v = p0 ? `${n}${p0.unit || (n === 0 ? "" : unit)}` : raw;
    if (o.onChange(v) === false) return show();
    value = v;
    const p = v === undefined ? null : parseLength(v);
    if (p) unit = p.unit;
    show();
  };
  const bump = (dir: 1 | -1) => {
    const step = o.step?.();
    if (!step) {
      return commit(
        bumpLength(
          value ?? "",
          dir,
          o.placeholder ? convertLength(o.placeholder, unit) : `0${unit}`,
        ),
      );
    }
    const n = parseLength(value ?? o.placeholder ?? "")?.n ?? 0;
    const k = dir > 0 ? Math.floor(n / step) + 1 : Math.ceil(n / step) - 1;
    commit(String(k * step));
  };
  input.onchange = () => {
    const t = input.value.trim();
    if (!t) return commit(undefined);
    const p = parseLength(t);
    if (!p) return show(); // not a length: put the old value back
    commit(`${p.n}${p.unit || unit}`);
  };
  input.onkeydown = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    bump(e.key === "ArrowUp" ? 1 : -1);
  };
  const btn = (name: "minus" | "plus", verb: string, dir: 1 | -1) => {
    const b = h("button", {
      type: "button",
      "aria-label": `${verb} ${o.label}`,
      tabindex: "-1",
    }, icon(name));
    b.onclick = () => bump(dir);
    return b;
  };
  show();
  return h(
    "span",
    { class: "st" },
    btn("minus", "Decrease", -1),
    input,
    u,
    btn("plus", "Increase", 1),
  );
}

// Segmented radio group. allowNone: clicking the checked option clears it
// (back to inherited).
export function seg<T extends string>(
  options: Array<{ value: T; label?: string; icon?: string; aria?: string }>,
  value: T | undefined,
  onChange: (v: T | undefined) => void,
  label: string,
  allowNone = false,
): HTMLElement {
  const g = h("span", {
    class: "seg",
    role: "radiogroup",
    "aria-label": label,
  });
  const btns = options.map((o) => {
    const b = h("button", {
      type: "button",
      role: "radio",
      "aria-checked": String(o.value === value),
      "aria-label": o.aria,
      title: o.aria,
    });
    if (o.icon) b.append(icon(o.icon as keyof typeof ICONS));
    else b.append(o.label ?? o.value);
    b.onclick = () => {
      const clear = allowNone && b.getAttribute("aria-checked") === "true";
      btns.forEach((x) =>
        x.setAttribute("aria-checked", String(!clear && x === b))
      );
      onChange(clear ? undefined : o.value);
    };
    return b;
  });
  g.append(...btns);
  return g;
}

export function toggle(
  label: string,
  on: boolean,
  onChange: (on: boolean) => void,
): HTMLElement {
  const b = h("button", {
    type: "button",
    class: "tog",
    "aria-pressed": String(on),
  }, label);
  b.onclick = () => {
    const v = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(v));
    onChange(v);
  };
  return b;
}

// A switch: a checkbox drawn as a pill track and knob (app.css `.sw`). Its row
// label names it, so the input itself carries only the aria-label.
export function switchInput(
  label: string,
  on: boolean,
  onChange: (on: boolean) => void,
): HTMLInputElement {
  const input = h("input", {
    type: "checkbox",
    role: "switch",
    class: "sw",
    "aria-label": label,
  });
  input.checked = on;
  input.onchange = () => onChange(input.checked);
  return input;
}

export function select(
  options: Array<{ label: string; value: string }>,
  value: string,
  onChange: (v: string) => void,
  label: string,
): HTMLSelectElement {
  const s = h("select", { class: "sel", "aria-label": label });
  for (const o of options) {
    s.append(new Option(o.label, o.value, false, o.value === value));
  }
  s.onchange = () => onChange(s.value);
  return s;
}

// `set` puts the "set here" dot on the label; `note` is the muted "from" text
// under it.
export function row(
  label: string,
  control: Node,
  opts: { set?: boolean; note?: string; hidden?: boolean } = {},
): HTMLElement {
  const lbl = h("span", { class: "lbl" }, label);
  if (opts.note) lbl.append(h("span", { class: "from" }, opts.note));
  const r = h(
    "div",
    { class: opts.set ? "row set" : "row" },
    lbl,
    h("div", { class: "ctl" }, control),
  );
  r.hidden = !!opts.hidden;
  return r;
}

// "On N pages" for a style key: hover outlines every match, a click steps
// through them. None while the key is on no page. A view with only one of
// these shows it in its heading (config-panel.ts).
export function applies(
  ctx: PanelContext,
  key: string,
): HTMLElement | undefined {
  const n = ctx.preview.pagesFor(key);
  if (n <= 0) return undefined;
  const b = h(
    "button",
    { type: "button", class: "applies", title: "Hover to outline every match" },
    `On ${n} page${n === 1 ? "" : "s"}`,
  );
  const hl = (on: boolean) => () => ctx.preview.highlight(key, on);
  b.onmouseenter = hl(true);
  b.onmouseleave = hl(false);
  b.onfocus = hl(true);
  b.onblur = hl(false);
  b.onclick = () => ctx.preview.reveal(key);
  return b;
}

export function section(
  title: string,
  focus: string,
  children: Node[],
  aside?: Node,
): HTMLElement {
  const head = h("div", { class: "sech" }, h("h3", {}, title));
  if (aside) head.append(aside);
  return h("section", { class: "sec", "data-focus": focus }, head, ...children);
}

// Collapsed CSS escape hatch. Properties in `controlled` have a control of
// their own, so they are refused here and the hint points at that control.
export function moreCss(
  label: string,
  props: CssProps,
  onChange: (props: CssProps) => void,
  controlled: string[],
): HTMLDetailsElement {
  const mine = (p: CssProps) =>
    Object.fromEntries(
      Object.entries(p).filter(([k]) => !controlled.includes(k)),
    );
  const title = (n: number) => `${label} (${n})`;
  const kept = mine(props);
  const text = h("span", {}, title(Object.keys(kept).length));
  const hint = h("p", { class: "hint" });
  hint.hidden = true;
  const ta = h("textarea", {
    "aria-label": label,
    spellcheck: "false",
    placeholder: "margin-left: 10mm",
  });
  ta.value = formatCssLines(kept);
  ta.oninput = () => {
    const parsed = parseCssLines(ta.value);
    const next = mine(parsed);
    const refused = Object.keys(parsed).filter((k) => controlled.includes(k));
    hint.hidden = !refused.length;
    hint.textContent = `Use the control above for ${refused.join(", ")}.`;
    text.textContent = title(Object.keys(next).length);
    onChange(next);
  };
  const d = h(
    "details",
    { class: "more" },
    h("summary", {}, icon("chevR"), text),
    ta,
    hint,
  );
  return d;
}
