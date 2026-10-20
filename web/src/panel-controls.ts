// web/src/panel-controls.ts — DOM controls for the style panel (rows, steppers,
// segments, toggles, selects, sections). Styled by the `#config-overlay` rules
// in index.html. DOM assembly only; length maths lives in config-data.ts.
import type { CssProps, Metadata } from "../../metadata/types.ts";
import {
  bumpLength,
  formatCssLines,
  parseCssLines,
  parseLength,
} from "./config-data.ts";
import type { PanelContext } from "./style-catalog.ts";

const ICONS = {
  minus: '<path d="M4 8h8"/>',
  plus: '<path d="M4 8h8M8 4v8"/>',
  chevR: '<path d="M6.5 4 10.5 8l-4 4"/>',
  chevL: '<path d="M9.5 4 5.5 8l4 4"/>',
  alignL: '<path d="M3 4h10M3 7h6M3 10h10M3 13h6"/>',
  alignC: '<path d="M3 4h10M5 7h6M3 10h10M5 13h6"/>',
  alignR: '<path d="M3 4h10M7 7h6M3 10h10M7 13h6"/>',
  alignJ: '<path d="M3 4h10M3 7h10M3 10h10M3 13h10"/>',
  reset: '<path d="M3.5 7.5a4.5 4.5 0 1 1 1.3 3.2"/><path d="M3.5 3.5v4h4"/>',
  eye:
    '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  pointer: '<path d="M4 2.5 12 8l-3.6.8L10.6 13l-1.5.7-2.2-4.2L4 12z"/>',
};

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", "i");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name]; // constant strings above, never user input
  return s;
}

function h<K extends keyof HTMLElementTagNameMap>(
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

export function makeView(ctx: PanelContext, after = () => {}): View {
  const marks: Array<[HTMLElement, () => boolean]> = [];
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
      marks.forEach(paint);
      after();
    },
  };
}

// Length field: takes and emits CSS lengths ("9pt"). The unit is shown beside
// the number and kept; empty means unset. `placeholder` is the inherited value.
// onChange returning false rejects the value: the field shows the old one.
export function stepper(o: {
  value: string | undefined;
  placeholder?: string;
  label: string;
  onChange(v: string | undefined): void | false;
}): HTMLElement {
  let value = o.value;
  let unit = parseLength(value ?? o.placeholder ?? "")?.unit ?? "";
  const num = (v: string | undefined) => {
    const p = v === undefined ? null : parseLength(v);
    return p ? String(p.n) : "";
  };
  const input = h("input", {
    type: "text",
    inputmode: "decimal",
    "aria-label": o.label,
    autocomplete: "off",
    placeholder: num(o.placeholder),
  });
  const u = h("span", { class: "u" }, unit);
  const show = () => {
    input.value = num(value);
    u.textContent = unit;
  };
  const commit = (v: string | undefined) => {
    if (o.onChange(v) === false) return show();
    value = v;
    const p = v === undefined ? null : parseLength(v);
    if (p) unit = p.unit;
    show();
  };
  const bump = (dir: 1 | -1) =>
    commit(bumpLength(value ?? "", dir, o.placeholder ?? `0${unit}`));
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

// `set` puts the "set here" dot on the label; `note` is the muted "from" text.
export function row(
  label: string,
  control: Node,
  opts: { set?: boolean; note?: string; hidden?: boolean } = {},
): HTMLElement {
  const r = h(
    "div",
    { class: opts.set ? "row set" : "row" },
    h("span", { class: "lbl" }, label),
    h("div", { class: "ctl" }, control),
  );
  if (opts.note) {
    r.lastElementChild!.append(h("span", { class: "from" }, opts.note));
  }
  r.hidden = !!opts.hidden;
  return r;
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

export function crumb(name: string, back: () => void): HTMLElement {
  const b = h(
    "button",
    { type: "button", class: "ghost" },
    icon("chevL"),
    "Book parts",
  );
  b.onclick = back;
  return h(
    "div",
    { class: "crumb" },
    b,
    h("span", { style: "color:var(--muted)" }, "/"),
    h("strong", {}, name),
  );
}
