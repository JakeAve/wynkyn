// web/src/config-panel.ts — the style panel (spec R1): a header with four
// tabs (Page · Fonts · Book parts · Print), save status and close, over a tab
// body rendered from a Route. Each tab's builder lives in its own panel-*.ts;
// this file owns the debounced save, routing, and the DOM helpers the
// builders share. Reusable transforms live in config-data.ts with tests.
import type { Metadata } from "../../metadata/types.ts";
import { buildFontsTab } from "./panel-fonts.ts";
import { buildPageTab, buildPrintTab } from "./panel-page.ts";
import { buildPartsTab } from "./panel-parts.ts";
import {
  type PanelContext,
  type PreviewLink,
  type Route,
  routeFor,
  type TabId,
} from "./style-catalog.ts";

const SAVE_DEBOUNCE_MS = 600;

export interface ConfigPanel {
  toggle(): void;
  isDirty(): boolean; // sections touched but not yet handed to saveSections
  refresh(metadata: Metadata): void; // rebuild the form from fresh metadata
  markSaved(ok: boolean, detail?: string): void; // feedback from the save round-trip
  selectStyle(key: string): void; // open the panel where a catalog entry is styled (§7.4)
}

export interface ConfigPanelOptions {
  overlay: HTMLElement;
  metadata: Metadata;
  saveSections(sections: Partial<Metadata>): void;
  preview: PreviewLink;
}

const TABS: Array<[TabId, string]> = [
  ["page", "Page"],
  ["fonts", "Fonts"],
  ["parts", "Book parts"],
  ["print", "Print"],
];

export function createConfigPanel(opts: ConfigPanelOptions): ConfigPanel {
  let meta = structuredClone(opts.metadata);
  const dirty = new Set<keyof Metadata>();
  let timer = 0;

  const saved = document.createElement("span");
  saved.className = "cfg-saved";
  saved.setAttribute("aria-live", "polite");
  const setSaved = (text: string, state: "saving" | "ok" | "error") => {
    saved.textContent = text;
    saved.dataset.state = state;
  };

  const queueSave = (key: keyof Metadata): void => {
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
      for (const k of dirty) {
        sections[k] = (meta as Record<string, unknown>)[k] ?? null;
      }
      // Fonts rows can sit blank in the DOM while the user is still typing an
      // alias (see the Fonts tab's "+ font alias" button). A sibling
      // field's save must not flush that blank entry to disk — an empty
      // family produces a malformed css2 URL param in generateFontLinks and
      // can knock out every custom font in the live preview.
      if (
        dirty.has("fonts") && sections.fonts &&
        typeof sections.fonts === "object"
      ) {
        const filtered: Record<string, string> = {};
        for (
          const [alias, family] of Object.entries(
            sections.fonts as Record<string, string>,
          )
        ) {
          if (family) filtered[alias] = family;
        }
        sections.fonts = filtered;
      }
      dirty.clear();
      opts.saveSections(sections as Partial<Metadata>);
    }, SAVE_DEBOUNCE_MS);
  };

  let route: Route = { tab: "page" }; // survives refresh()

  const tablist = document.createElement("div");
  tablist.className = "tabs";
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Style sections");
  const tabs = TABS.map(([id, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.id = `cfg-tab-${id}`;
    b.dataset.tab = id;
    b.textContent = label;
    b.onclick = () => go({ tab: id });
    return b;
  });
  tablist.append(...tabs);
  // Roving tablist: arrows move the selection, only the selected tab tabs in.
  tablist.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.findIndex(([id]) => id === route.tab);
    const n = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) %
      TABS.length;
    go({ tab: TABS[n]![0] });
    tabs[n]!.focus();
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ghost";
  close.innerHTML =
    '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  close.setAttribute("aria-label", "Close style panel");
  close.title = "Close (Esc)";
  close.onclick = () => {
    opts.overlay.hidden = true;
  };
  const head = document.createElement("div");
  head.className = "phead";
  head.append(tablist, saved, close);
  const body = document.createElement("div");
  body.className = "pbody";
  body.setAttribute("role", "tabpanel");
  opts.overlay.replaceChildren(head, body);

  function go(next: Route): void {
    route = next;
    render();
  }

  function build(): Node[] {
    const ctx: PanelContext = { meta, queueSave, go, preview: opts.preview };
    switch (route.tab) {
      case "page":
        return buildPageTab(ctx);
      case "fonts":
        return buildFontsTab(ctx);
      case "print":
        return buildPrintTab(ctx);
      case "parts":
        return buildPartsTab(ctx, route.part);
    }
  }

  function render(keepScroll = false): void {
    for (const b of tabs) {
      const on = b.dataset.tab === route.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", `cfg-tab-${route.tab}`);
    const top = body.scrollTop;
    // A hovered "On N pages" button that is replaced never gets its mouseleave.
    for (const e of document.querySelectorAll("[data-style-hl]")) {
      e.removeAttribute("data-style-hl");
    }
    body.replaceChildren(...build());
    const focus = route.focus;
    if (focus) {
      route = { ...route, focus: undefined }; // flash once, not on every refresh
      const t = body.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
      if (t) {
        t.scrollIntoView({ block: "nearest" });
        t.classList.add("flash");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => t.classList.remove("flash"))
        );
      }
    } else body.scrollTop = keepScroll ? top : 0;
  }

  opts.overlay.setAttribute("role", "dialog");
  opts.overlay.setAttribute("aria-label", "Style");
  opts.overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      opts.overlay.hidden = true;
      e.stopPropagation();
    }
  });
  render();
  return {
    toggle: () => {
      opts.overlay.hidden = !opts.overlay.hidden;
      if (!opts.overlay.hidden) {
        tabs.find((b) => b.tabIndex === 0)?.focus();
      }
    },
    isDirty: () => dirty.size > 0,
    refresh(metadata: Metadata) {
      meta = structuredClone(metadata);
      render(true);
    },
    markSaved(ok, detail) {
      if (dirty.size) return; // a newer edit is already queued — stay on "Saving…"
      const at = new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      setSaved(
        ok ? `Saved ${at}` : `Not saved — ${detail ?? "error"}`,
        ok ? "ok" : "error",
      );
    },
    selectStyle(key) {
      opts.overlay.hidden = false;
      go(routeFor(key, meta));
    },
  };
}

// ---------- shared DOM helpers (used by the panel-*.ts tab builders) ----------

export function field(
  labelText: string,
  ...controls: HTMLElement[]
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "cfg-field";
  const span = document.createElement("span");
  span.className = "cfg-label";
  span.textContent = labelText;
  label.append(span, ...controls);
  return label;
}

export function textInput(
  value: string,
  onInput: (v: string) => void,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.oninput = () => onInput(el.value.trim());
  return el;
}

// Like textInput, but never trims. Use for fields where leading/trailing
// whitespace is semantically load-bearing (e.g. numbering prefix/suffix,
// which render.ts concatenates verbatim — "Part " + "IV").
export function textInputRaw(
  value: string,
  onInput: (v: string) => void,
): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.oninput = () => onInput(el.value);
  return el;
}

export function selectInput(
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

const INHERIT = "";
const OTHER = "__other";

// Font alias picker with an escape hatch for a literal family name.
export function fontControl(
  meta: Metadata,
  value: string | undefined,
  onChange: (v: string) => void,
  unsetAs: string, // what the box renders in with no font-family of its own
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
      { label: `(unset — ${unsetAs})`, value: INHERIT },
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
