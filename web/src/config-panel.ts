// web/src/config-panel.ts — document configuration panel (spec §7.5): a form
// UI over metadata.json's book-wide sections, one builder per section. DOM
// assembly only — reusable transforms live in config-data.ts with tests.
import type {
  Metadata,
  NumberingStyle,
  PageConfig,
  PrintConfig,
  RunningEntry,
} from "../../metadata/types.ts";
import {
  isValidFolios,
  isValidSize,
  makeRunningEntry,
  MARGIN_AREAS,
  NUMBERING_STYLES,
  PAGE_SIZE_PRESETS,
  presetFor,
  renameKey,
  RUNNING_CONTENT_CHOICES,
  splitRunningEntry,
} from "./config-data.ts";
import { GOOGLE_FONTS } from "./fonts-list.ts";

const SAVE_DEBOUNCE_MS = 600;

export interface ConfigPanel {
  toggle(): void;
  isDirty(): boolean; // sections touched but not yet handed to saveSections
  refresh(metadata: Metadata): void; // rebuild the form from fresh metadata
  markSaved(ok: boolean, detail?: string): void; // feedback from the save round-trip
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

  const saved = document.createElement("span");
  saved.className = "cfg-saved";
  const setSaved = (text: string, state: "saving" | "ok" | "error") => {
    saved.textContent = text;
    saved.dataset.state = state;
  };

  const queueSave: QueueSave = (key) => {
    dirty.add(key);
    setSaved("Saving…", "saving");
    clearTimeout(timer);
    timer = setTimeout(() => {
      const sections: Record<string, unknown> = {};
      // ?? null: defensive fallback for a section the user emptied out to
      // delete server-side. In the current UI every section builder eagerly
      // creates its object via `??=`, so meta[k] is always defined (possibly
      // {}) by the time this fires — this branch is not reachable today, but
      // is kept in case a future section is built lazily.
      for (const k of dirty) sections[k] = (meta as Record<string, unknown>)[k] ?? null;
      // Fonts rows can sit blank in the DOM while the user is still typing an
      // alias (see buildFontsSection's "+ font alias" button). A sibling
      // field's save must not flush that blank entry to disk — an empty
      // family produces a malformed css2 URL param in generateFontLinks and
      // can knock out every custom font in the live preview.
      if (dirty.has("fonts") && sections.fonts && typeof sections.fonts === "object") {
        const filtered: Record<string, string> = {};
        for (const [alias, family] of Object.entries(sections.fonts as Record<string, string>)) {
          if (family) filtered[alias] = family;
        }
        sections.fonts = filtered;
      }
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
    close.setAttribute("aria-label", "close");
    close.title = "close (Esc)";
    close.onclick = () => {
      opts.overlay.hidden = true;
    };
    head.append(title, saved, close);
    opts.overlay.append(
      head,
      buildPageSection(meta, queueSave),
      buildFontsSection(meta, queueSave),
      buildNumberingSection(meta, queueSave),
      buildRunningSection(meta, queueSave),
      buildPrintSection(meta, queueSave),
      buildNotesSection(meta, queueSave),
    );
  }

  opts.overlay.setAttribute("role", "dialog");
  opts.overlay.setAttribute("aria-label", "Document configuration");
  opts.overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      opts.overlay.hidden = true;
      e.stopPropagation();
    }
  });
  build();
  return {
    toggle: () => {
      opts.overlay.hidden = !opts.overlay.hidden;
      if (!opts.overlay.hidden) opts.overlay.querySelector<HTMLElement>("input, select")?.focus();
    },
    isDirty: () => dirty.size > 0,
    refresh(metadata: Metadata) {
      meta = structuredClone(metadata);
      build();
    },
    markSaved(ok, detail) {
      if (dirty.size) return; // a newer edit is already queued — stay on "Saving…"
      const at = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      setSaved(ok ? `Saved ${at}` : `Not saved — ${detail ?? "error"}`, ok ? "ok" : "error");
    },
  };
}

// ---------- shared DOM helpers (used by every section builder) ----------

// Sections are native <details>: Page and Fonts open by default, the rarer
// ones collapsed so the panel isn't one long wall of fields.
const OPEN_BY_DEFAULT = new Set(["Page", "Fonts"]);
function sectionBox(title: string): HTMLDetailsElement {
  const box = document.createElement("details");
  box.className = "cfg-section";
  box.open = OPEN_BY_DEFAULT.has(title);
  const summary = document.createElement("summary");
  summary.textContent = title;
  box.appendChild(summary);
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

// Like textInput, but never trims. Use for fields where leading/trailing
// whitespace is semantically load-bearing (e.g. numbering prefix/suffix,
// which render.ts concatenates verbatim — "Part " + "IV").
function textInputRaw(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.oninput = () => onInput(el.value);
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
  // Read-only snapshot for display — must not eagerly create page.margins,
  // or an edit to an unrelated field (e.g. size) would persist a spurious
  // empty margins object on save (the whole "page" section round-trips
  // together, so any local default-filling here leaks onto disk).
  const margins = page.margins ?? {};
  for (const key of MARGIN_KEYS) {
    box.appendChild(
      field(
        `margin ${key}`,
        textInput(margins[key] ?? "", (v) => {
          const m = page.margins ??= {};
          if (v) m[key] = v;
          else delete m[key];
          queueSave("page");
        }),
      ),
    );
  }
  return box;
}

function buildFontsSection(meta: Metadata, queueSave: QueueSave): HTMLElement {
  const box = sectionBox("Fonts");
  const dl = document.createElement("datalist");
  dl.id = "google-fonts-list";
  for (const f of GOOGLE_FONTS) dl.appendChild(new Option(f, f));
  const rows = document.createElement("div");
  const add = document.createElement("button");
  add.textContent = "+ font alias";

  function render(): void {
    rows.innerHTML = "";
    const fonts = meta.fonts ??= {};
    for (const alias of Object.keys(fonts)) {
      const aliasIn = document.createElement("input");
      aliasIn.type = "text";
      aliasIn.value = alias;
      aliasIn.placeholder = "alias";
      aliasIn.setAttribute("aria-label", "font alias");
      // Rename on commit (change = blur/enter), not per keystroke — a
      // half-typed alias must not repeatedly rename the key.
      aliasIn.onchange = () => {
        const next = aliasIn.value.trim();
        if (!next || next === alias) {
          aliasIn.value = alias;
          return;
        }
        if (Object.hasOwn(fonts, next)) {
          aliasIn.value = alias; // collision: refuse silently, keep old name
          return;
        }
        meta.fonts = renameKey(fonts, alias, next);
        queueSave("fonts");
        render();
      };
      const familyIn = textInput(fonts[alias] ?? "", (v) => {
        fonts[alias] = v;
        // Empty family would put a blank entry in the css2 URL — save once
        // there's a real value; deletion is the ✕ button's job.
        if (v) queueSave("fonts");
      });
      familyIn.setAttribute("list", "google-fonts-list");
      familyIn.placeholder = "Google Fonts family";
      familyIn.setAttribute("aria-label", "font family");
      const rm = document.createElement("button");
      rm.textContent = "✕";
      rm.title = `remove ${alias}`;
      rm.onclick = () => {
        delete fonts[alias];
        queueSave("fonts");
        render();
      };
      const row = document.createElement("div");
      row.className = "cfg-field";
      row.append(aliasIn, familyIn, rm);
      rows.appendChild(row);
    }
  }

  add.onclick = () => {
    const fonts = meta.fonts ??= {};
    let alias = "new-font";
    for (let i = 2; Object.hasOwn(fonts, alias); i++) alias = `new-font-${i}`;
    fonts[alias] = "";
    render(); // not saved until a family name is typed (see familyIn)
  };

  render();
  box.append(dl, rows, add);
  return box;
}

const STYLE_CHOICES = NUMBERING_STYLES.map((s) => ({ label: s, value: s }));

function buildNumberingSection(meta: Metadata, queueSave: QueueSave): HTMLElement {
  const box = sectionBox("Numbering");
  const numbering = meta.numbering ??= {};

  // Read-only snapshots for display — must not eagerly create
  // numbering.chapters/parts/pages[zone], or an edit to one of them (e.g.
  // chapters.style) would persist a spurious empty sibling (e.g. parts: {})
  // on save, since the whole "numbering" section round-trips together.
  for (const key of ["chapters", "parts"] as const) {
    const cfg = numbering[key] ?? {};
    box.appendChild(
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
    );
    box.appendChild(
      field(`${key} prefix`, textInputRaw(cfg.prefix ?? "", (v) => {
        (numbering[key] ??= {}).prefix = v;
        queueSave("numbering");
      })),
    );
    box.appendChild(
      field(`${key} suffix`, textInputRaw(cfg.suffix ?? "", (v) => {
        (numbering[key] ??= {}).suffix = v;
        queueSave("numbering");
      })),
    );
  }

  const pages = numbering.pages ?? {};
  for (const zone of ["front-matter", "body", "back-matter"] as const) {
    const cfg = pages[zone] ?? {};
    box.appendChild(
      field(
        `${zone} pages`,
        selectInput(STYLE_CHOICES, cfg.style ?? "arabic", (v) => {
          ((numbering.pages ??= {})[zone] ??= {}).style = v as NumberingStyle;
          queueSave("numbering");
        }),
        inlineLabel(
          "show",
          checkboxInput(cfg.show ?? true, (v) => {
            ((numbering.pages ??= {})[zone] ??= {}).show = v;
            queueSave("numbering");
          }),
        ),
      ),
    );
  }
  return box;
}

const AREA_CHOICES = MARGIN_AREAS.map((a) => ({ label: a, value: a }));
const LITERAL = "__literal"; // select sentinel for "type your own text"

function buildRunningSection(meta: Metadata, queueSave: QueueSave): HTMLElement {
  const box = sectionBox("Running headers / footers");
  const running = meta.running ??= {};

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

    function render(): void {
      list.innerHTML = "";
      (running[side] ?? []).forEach((_, i) => list.appendChild(entryRow(i)));
    }

    function entryRow(i: number): HTMLElement {
      const entries = running[side]!;
      const form = splitRunningEntry(entries[i]!);
      const commit = () => {
        entries[i] = makeRunningEntry(form);
        queueSave("running");
      };
      const row = document.createElement("div");
      row.className = "cfg-entry";

      const isChoice = (RUNNING_CONTENT_CHOICES as readonly string[]).includes(form.content);
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
      css.oninput = () => {
        form.extraCss = css.value;
        commit();
      };

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
        field("extra css", css),
        rm,
      );
      return row;
    }

    add.onclick = () => {
      const entries = running[side] ??= [];
      // Sensible seed per §4.8's example: outer top corner of the spread.
      const seed: RunningEntry = { content: "book-title", area: side === "odd" ? "top-right" : "top-left" };
      entries.push(seed);
      queueSave("running");
      render();
    };

    render();
    box.append(head, list);
  }
  return box;
}

function buildPrintSection(meta: Metadata, queueSave: QueueSave): HTMLElement {
  const box = sectionBox("Print (export only)");
  const print: PrintConfig = meta.print ??= {};
  box.appendChild(
    field(
      "sheet size",
      sizeControl(print["sheet-size"], (v) => {
        print["sheet-size"] = v;
        queueSave("print");
      }),
    ),
  );
  const error = document.createElement("span");
  error.className = "cfg-error";
  const folios = textInput(String(print["folios-per-signature"] ?? ""), (v) => {
    if (isValidFolios(v)) {
      error.textContent = "";
      print["folios-per-signature"] = Number(v);
      queueSave("print");
    } else {
      error.textContent = v ? "must be a positive integer" : "";
    }
  });
  folios.placeholder = "4";
  box.appendChild(field("folios/signature", folios, error));
  const note = document.createElement("p");
  note.style.color = "#9aa0ab";
  note.style.margin = "6px 0 0";
  note.textContent =
    "Consumed by print export (Plan 5) — changing these does not affect the preview.";
  box.appendChild(note);
  return box;
}

function buildNotesSection(meta: Metadata, queueSave: QueueSave): HTMLElement {
  const box = sectionBox("Notes");
  const notes = meta.notes ??= {};
  box.appendChild(
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
          queueSave("notes");
        },
      ),
    ),
  );
  return box;
}
