// web/src/config-panel.ts — the style panel (spec R1) as columns: a nav of
// book settings and parts (style mode) or publish sections (publish mode), and the
// chosen route's view under a header with the save status. Publish draws its
// signature into a separate sheet view. Each view's builder lives in its own
// panel-*.ts; this file owns the debounced save, routing, and the DOM helpers
// the builders share. Reusable transforms live in config-data.ts with tests.
import type { Metadata } from "../../metadata/types.ts";
import { buildFontsTab } from "./panel-fonts.ts";
import { buildPageTab, buildPublishTab } from "./panel-page.ts";
import { buildPartsTab } from "./panel-parts.ts";
import { buildThemesTab, markTried } from "./panel-themes.ts";
import {
  addIsNames,
  type BookPart,
  bookParts,
  catalogFor,
  type EpubResult,
  type PanelContext,
  type PreviewLink,
  type Route,
  routeFor,
  setCount,
} from "./style-catalog.ts";

const SAVE_DEBOUNCE_MS = 600;

export type PanelMode = "style" | "publish";

export interface ConfigPanel {
  setMode(mode: PanelMode): void; // swap the nav and body between style and publish
  isDirty(): boolean; // sections touched but not yet handed to saveSections
  flush(): void; // hand any pending sections to saveSections now
  refresh(metadata: Metadata): void; // rebuild the form from fresh metadata
  selectStyle(key: string): void; // style mode, where a catalog entry is styled (§7.4)
  pagesChanged(): void; // the preview repaginated
  open(view: string): void; // the nav row `view` (navId), if this book has it
  themeTried(slug: string | null): void; // mark the previewed theme's card
}

export interface ConfigPanelOptions {
  overlay: HTMLElement; // the middle column: header and the route's view
  nav: HTMLElement; // the left column
  sheetView: HTMLElement; // the right column in publish mode
  metadata: Metadata;
  saveSections(sections: Partial<Metadata>): void;
  onEdit(): void; // an edit is queued; saveSections follows after the debounce
  preview: PreviewLink;
  isNames(): string[]; // `{is}` classes the manuscript uses
  exportEpub(): Promise<EpubResult>;
  toStyle(view: string): void; // leave Publish for a Style view, Back returns
  view?: string | null; // the nav row to open on (navId); unknown = default
  onRoute?(id: string): void; // the nav row changed (for the URL)
  tryTheme(slug: string | null): void; // preview a theme; null on leaving the Theme view
  applyTheme(slug: string): void; // the app's Apply flow
}

const GROUPS: Array<[BookPart["group"], string]> = [
  ["furniture", "Page furniture"],
  ["front", "Front matter"],
  ["body", "Body"],
  ["back", "Back matter"],
  ["custom", "Custom styles"],
];

// Publish nav rows: the Publish view's section focus keys (panel-page.ts).
// Grouped by what the author is making: sheets to fold and bind, a PDF of
// the pages, or an e-book.
const PUBLISH: Array<[string, Array<[string, string]>]> = [
  ["Binding", [
    ["sheet", "Paper"],
    ["fold", "Folding"],
    ["folios-per-signature", "Signatures"],
    ["print", "Print"],
  ]],
  ["PDF", [["pdf", "Pages"]]],
  ["E-book", [["ebook", "EPUB"]]],
];

interface NavRow {
  id: string; // matches navId(route)
  label: string;
  count?: number;
  route: Route;
}

// Which nav row a route belongs to.
function navId(route: Route): string {
  if (route.tab === "publish") return `publish:${route.focus ?? "sheet"}`;
  return route.tab === "parts" ? route.part ?? "" : route.tab;
}

function styleNav(meta: Metadata): Array<[string, NavRow[]]> {
  const parts = bookParts(meta);
  const catalog = new Map(catalogFor(meta).map((e) => [e.key, e]));
  const row = (p: BookPart, label = p.name): NavRow => ({
    id: p.id,
    label,
    count: setCount(meta, p, catalog),
    route: { tab: "parts", part: p.id },
  });
  const body = parts.find((p) => p.id === "body")!;
  const out: Array<[string, NavRow[]]> = [[
    "Book",
    [
      { id: "themes", label: "Theme", route: { tab: "themes" } },
      { id: "page", label: "Page size & margins", route: { tab: "page" } },
      { id: "fonts", label: "Fonts", route: { tab: "fonts" } },
      row(body),
    ],
  ]];
  for (const [group, title] of GROUPS) {
    const mine = parts.filter((p) => p.group === group && p !== body);
    if (mine.length) out.push([title, mine.map((p) => row(p))]);
  }
  return out;
}

const PUBLISH_NAV: Array<[string, NavRow[]]> = PUBLISH.map((
  [group, rows],
) => [
  group,
  rows.map(([focus, label]) => ({
    id: `publish:${focus}`,
    label,
    route: { tab: "publish", focus },
  })),
]);

// The route behind a nav row id, or null for one this book doesn't have.
function routeById(id: string, meta: Metadata): Route | null {
  for (const [, rows] of [...styleNav(meta), ...PUBLISH_NAV]) {
    const row = rows.find((r) => r.id === id);
    if (row) return row.route;
  }
  return null;
}

export function createConfigPanel(opts: ConfigPanelOptions): ConfigPanel {
  let meta = structuredClone(opts.metadata);
  const dirty = new Set<keyof Metadata>();
  let timer = 0;

  const queueSave = (key: keyof Metadata): void => {
    dirty.add(key);
    opts.onEdit();
    clearTimeout(timer);
    timer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  };

  // Hands the dirty sections to saveSections now; the debounce ends here.
  function flushSave(): void {
    clearTimeout(timer);
    if (!dirty.size) return;
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
    // Unstyled `{is}` classes (addIsNames) stay off disk.
    if (sections.is) {
      sections.is = Object.fromEntries(
        Object.entries(sections.is).filter(([, p]) => Object.keys(p).length),
      );
    }
    dirty.clear();
    opts.saveSections(sections as Partial<Metadata>);
    renderNav(); // the "N set" counts follow the edit, once per save
  }
  let onPages: (() => void) | null = null; // the open view's redraw, if any

  // Both survive refresh(); the style route also survives a trip to publish.
  const home: Route = { tab: "parts", part: "folios" };
  let route = (opts.view ? routeById(opts.view, meta) : null) ?? home;
  let styleRoute = route.tab === "publish" ? home : route;
  let current = navId(route); // the nav row to mark, kept past focus's flash
  opts.onRoute?.(current); // the healed row, so the URL drops an unknown one

  const crumbs = document.createElement("span");
  crumbs.className = "crumbs";
  const head = document.createElement("div");
  head.className = "phead";
  head.append(crumbs);
  const body = document.createElement("div");
  body.className = "pbody";
  opts.overlay.replaceChildren(head, body);

  let tried: string | null = null;

  function go(next: Route): void {
    if (route.tab === "themes" && next.tab !== "themes") opts.tryTheme(null);
    route = next;
    if (next.tab !== "publish") styleRoute = next;
    current = navId(next);
    opts.onRoute?.(current);
    render();
  }

  function renderNav(): void {
    const groups = route.tab === "publish" ? PUBLISH_NAV : styleNav(meta);
    opts.nav.setAttribute(
      "aria-label",
      route.tab === "publish" ? "Publish sections" : "Style sections",
    );
    crumbs.replaceChildren();
    opts.nav.replaceChildren(...groups.flatMap(([title, rows]) => {
      const h = document.createElement("div");
      h.className = "nh";
      h.textContent = title;
      return [
        h,
        ...rows.map((r) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ni";
          const t = document.createElement("span");
          t.className = "t";
          t.textContent = r.label;
          const k = document.createElement("span");
          k.className = "k";
          k.textContent = r.count ? `${r.count} set` : "";
          b.append(t, k);
          if (r.id === current) {
            b.setAttribute("aria-current", "true");
            const name = document.createElement("b");
            name.textContent = r.label;
            crumbs.append(`${title} / `, name);
          }
          b.onclick = () => go(r.route);
          return b;
        }),
      ];
    }));
  }

  function build(): Node[] {
    onPages = null;
    const ctx: PanelContext = {
      meta,
      queueSave,
      go,
      preview: opts.preview,
      sheetView: opts.sheetView,
      exportEpub: () => {
        flushSave();
        return opts.exportEpub();
      },
      toStyle: (view, from) => {
        current = `publish:${from}`; // Back lands on the section left from
        opts.onRoute?.(current);
        opts.toStyle(view);
      },
      onPages: (redraw) => {
        onPages = redraw;
      },
      tryTheme: (slug) => opts.tryTheme(slug),
      applyTheme: (slug) => opts.applyTheme(slug),
      themeTried: tried,
    };
    switch (route.tab) {
      case "themes":
        return buildThemesTab(ctx);
      case "page":
        return buildPageTab(ctx);
      case "fonts":
        return buildFontsTab(ctx);
      case "publish":
        return buildPublishTab(ctx);
      case "parts":
        return buildPartsTab(ctx, route.part);
    }
  }

  function render(keepScroll = false): void {
    addIsNames(meta, opts.isNames());
    renderNav();
    const top = body.scrollTop;
    // A hovered "On N pages" button that is replaced never gets its mouseleave.
    for (const e of document.querySelectorAll("[data-style-hl]")) {
      e.removeAttribute("data-style-hl");
    }
    if (route.tab !== "publish") opts.sheetView.replaceChildren();
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

  render();
  return {
    setMode: (mode) => {
      if ((route.tab === "publish") === (mode === "publish")) return;
      go(mode === "publish" ? { tab: "publish" } : styleRoute);
    },
    isDirty: () => dirty.size > 0,
    flush: flushSave,
    refresh(metadata: Metadata) {
      meta = structuredClone(metadata);
      render(true);
    },
    pagesChanged: () => onPages?.(),
    open(view) {
      const next = routeById(view, meta);
      if (next) go(next);
    },
    themeTried(slug) {
      tried = slug;
      markTried(body, slug);
    },
    selectStyle(key) {
      addIsNames(meta, opts.isNames());
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
