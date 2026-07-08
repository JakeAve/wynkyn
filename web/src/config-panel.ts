// web/src/config-panel.ts — document configuration panel (spec §7.5): a form
// UI over metadata.json's book-wide sections, one builder per section. DOM
// assembly only — reusable transforms live in config-data.ts with tests.
import type { Metadata, PageConfig } from "../../metadata/types.ts";
import { isValidSize, PAGE_SIZE_PRESETS, presetFor } from "./config-data.ts";

const SAVE_DEBOUNCE_MS = 600;

export interface ConfigPanel {
  toggle(): void;
  isDirty(): boolean; // sections touched but not yet handed to saveSections
  refresh(metadata: Metadata): void; // rebuild the form from fresh metadata
}

export interface ConfigPanelOptions {
  overlay: HTMLElement;
  metadata: Metadata;
  saveSections(sections: Partial<Metadata>): void;
}

type QueueSave = (key: keyof Metadata) => void;

export function createConfigPanel(opts: ConfigPanelOptions): ConfigPanel {
  let meta = structuredClone(opts.metadata);
  const dirty = new Set<keyof Metadata>();
  let timer = 0;

  const queueSave: QueueSave = (key) => {
    dirty.add(key);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const sections: Record<string, unknown> = {};
      // ?? null: a section the user emptied out is deleted server-side.
      for (const k of dirty) sections[k] = (meta as Record<string, unknown>)[k] ?? null;
      dirty.clear();
      opts.saveSections(sections as Partial<Metadata>);
    }, SAVE_DEBOUNCE_MS);
  };

  function build(): void {
    opts.overlay.innerHTML = "";
    const head = document.createElement("div");
    head.className = "cfg-head";
    const title = document.createElement("strong");
    title.textContent = "Document configuration";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.onclick = () => {
      opts.overlay.hidden = true;
    };
    head.append(title, close);
    opts.overlay.append(
      head,
      buildPageSection(meta, queueSave),
      // Tasks 4–7 append here: fonts, numbering, running, print, notes.
    );
  }

  build();
  return {
    toggle: () => {
      opts.overlay.hidden = !opts.overlay.hidden;
    },
    isDirty: () => dirty.size > 0,
    refresh(metadata: Metadata) {
      meta = structuredClone(metadata);
      build();
    },
  };
}

// ---------- shared DOM helpers (used by every section builder) ----------

function sectionBox(title: string): HTMLFieldSetElement {
  const box = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = title;
  box.appendChild(legend);
  return box;
}

function field(labelText: string, ...controls: HTMLElement[]): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "cfg-field";
  const span = document.createElement("span");
  span.className = "cfg-label";
  span.textContent = labelText;
  label.append(span, ...controls);
  return label;
}

function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.oninput = () => onInput(el.value.trim());
  return el;
}

function selectInput(
  choices: ReadonlyArray<{ label: string; value: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const el = document.createElement("select");
  for (const c of choices) {
    el.appendChild(new Option(c.label, c.value, false, c.value === value));
  }
  el.onchange = () => onChange(el.value);
  return el;
}

function checkboxInput(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "checkbox";
  el.checked = checked;
  el.onchange = () => onChange(el.checked);
  return el;
}

// A small label glued to a control (e.g. "show" next to its checkbox),
// distinct from field()'s fixed-width row label.
function inlineLabel(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cfg-inline";
  const s = document.createElement("span");
  s.textContent = text;
  wrap.append(control, s);
  return wrap;
}

// Preset dropdown + custom-dimensions input (spec §7.5: named presets and
// custom dimensions). Used for page.size now and print.sheet-size in Task 7.
// Calls onChange only with valid values; invalid custom input shows an error.
function sizeControl(
  current: string | undefined,
  onChange: (size: string) => void,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cfg-row";
  const preset = presetFor(current);
  const custom = document.createElement("input");
  custom.type = "text";
  custom.placeholder = "5.5in 8.5in";
  custom.value = preset === "custom" ? (current ?? "") : "";
  custom.hidden = preset !== "custom";
  const error = document.createElement("span");
  error.className = "cfg-error";
  const sel = selectInput(
    [
      ...PAGE_SIZE_PRESETS.map((p) => ({ label: p.label, value: p.value })),
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

// ---------- sections ----------

const MARGIN_KEYS = ["top", "bottom", "inside", "outside"] as const;

function buildPageSection(meta: Metadata, queueSave: QueueSave): HTMLElement {
  const page: PageConfig = meta.page ??= {};
  const box = sectionBox("Page");
  box.appendChild(
    field(
      "size",
      sizeControl(page.size, (size) => {
        page.size = size;
        queueSave("page");
      }),
    ),
  );
  const margins = page.margins ??= {};
  for (const key of MARGIN_KEYS) {
    box.appendChild(
      field(
        `margin ${key}`,
        textInput(margins[key] ?? "", (v) => {
          if (v) margins[key] = v;
          else delete margins[key];
          queueSave("page");
        }),
      ),
    );
  }
  return box;
}
