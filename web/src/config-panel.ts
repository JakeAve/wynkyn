// web/src/config-panel.ts — the style panel (spec R1) as columns: a nav of
// book settings and parts (style mode) or publish sections (publish mode), and the
// chosen route's view under a header with the save status. Publish draws its
// signature into a separate sheet view. Each view's builder lives in its own
// panel-*.ts; this file owns the debounced save, routing, and the DOM helpers
// the builders share. Reusable transforms live in config-data.ts with tests.
import type { Metadata } from "../../metadata/types.ts";
import { buildColorsTab } from "./panel-colors.ts";
import { buildFontsTab } from "./panel-fonts.ts";
import { buildPageTab, buildPublishTab } from "./panel-page.ts";
import { buildPartsTab } from "./panel-parts.ts";
import { buildThemesTab, markTried } from "./panel-themes.ts";
import {
  type BookPart,
  bookParts,
  catalogFor,
  entryName,
  type EpubResult,
  type PanelContext,
  type PreviewLink,
  type Route,
  routeFor,
  setCount,
  type StyleStep,
  syncIsNames,
} from "./style-catalog.ts";

export type PanelMode = "style" | "publish";

export interface ConfigPanel {
  setMode(mode: PanelMode): void; // swap the nav and body between style and publish
  refresh(metadata: Metadata): void; // rebuild the form from fresh metadata
  selectStyle(key: string, path?: StyleStep[]): void; // style mode, where a catalog entry is styled (§7.4); `path`, every style under the click
  pagesChanged(): void; // the preview repaginated
  isNamesChanged(): void; // the manuscript was reparsed; Custom styles follow it
  open(view: string): void; // the nav row `view` (navId), if this book has it
  themeTried(slug: string | null): void; // mark the previewed theme's card
}

export interface ConfigPanelOptions {
  overlay: HTMLElement; // the middle column: header and the route's view
  nav: HTMLElement; // the left column
  sheetView: HTMLElement; // the right column in publish mode
  metadata: Metadata;
  saveSections(sections: Partial<Metadata>): void; // every edit; the app debounces
  onEdit(): void; // an edit is made; saveSections follows at once
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
    ["marks", "Binding marks"],
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
      { id: "colors", label: "Colors", route: { tab: "colors" } },
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

  // Hands the edited section to saveSections.
  function queueSave(key: keyof Metadata): void {
    opts.onEdit();
    const sections: Record<string, unknown> = {};
    // ?? null: defensive fallback for a section the user emptied out to
    // delete server-side. In the current UI every section builder eagerly
    // creates its object via `??=`, so meta[k] is always defined (possibly
    // {}) by the time this fires — this branch is not reachable today, but
    // is kept in case a future section is built lazily.
    sections[key] = (meta as Record<string, unknown>)[key] ?? null;
    // Fonts rows can sit blank in the DOM while the user is still typing an
    // alias (see the Fonts tab's "+ font alias" button). A sibling
    // field's save must not flush that blank entry to disk — an empty
    // family produces a malformed css2 URL param in generateFontLinks and
    // can knock out every custom font in the live preview.
    if (sections.fonts && typeof sections.fonts === "object") {
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
    // Likewise a new color before one is picked (the Colors view).
    if (sections.colors && typeof sections.colors === "object") {
      sections.colors = Object.fromEntries(
        Object.entries(sections.colors).filter(([, v]) => v),
      );
    }
    // Unstyled `{is}` classes (syncIsNames) stay off disk.
    if (sections.is) {
      sections.is = Object.fromEntries(
        Object.entries(sections.is).filter(([, p]) => Object.keys(p).length),
      );
    }
    opts.saveSections(sections as Partial<Metadata>);
    renderNav(true); // the "N set" counts follow the edit
  }
  let onPages: (() => void) | null = null; // the open view's redraw, if any

  // Both survive refresh(); the style route also survives a trip to publish.
  const home: Route = { tab: "parts", part: "folios" };
  let route = (opts.view ? routeById(opts.view, meta) : null) ?? home;
  let styleRoute = route.tab === "publish" ? home : route;
  let current = navId(route); // the nav row to mark, kept past focus's flash
  opts.onRoute?.(current); // the healed row, so the URL drops an unknown one

  // The view heading: the nav group over the row's name, and "On N pages"
  // when the view has just one (render() lifts it out of the view).
  const crumb = document.createElement("span");
  crumb.className = "crumb";
  const title = document.createElement("h2");
  const where = document.createElement("span");
  const titleRow = document.createElement("div");
  titleRow.className = "vh-row";
  titleRow.append(title, where);
  const here = document.createElement("div");
  here.className = "here";
  const head = document.createElement("div");
  head.className = "phead";
  head.append(crumb, titleRow, here);
  const body = document.createElement("div");
  body.className = "pbody";
  opts.overlay.replaceChildren(head, body);

  let tried: string | null = null;
  // The styles under the preview click that opened the view, and the one open.
  let trail: { steps: StyleStep[]; key: string } | null = null;

  function go(next: Route, nextTrail: typeof trail = null): void {
    if (route.tab === "themes" && next.tab !== "themes") opts.tryTheme(null);
    route = next;
    trail = nextTrail;
    if (next.tab !== "publish") styleRoute = next;
    current = navId(next);
    opts.onRoute?.(current);
    render();
  }

  let navShown = ""; // what renderNav last drew, so an edit redraws on change
  function renderNav(ifChanged = false): void {
    const groups = route.tab === "publish" ? PUBLISH_NAV : styleNav(meta);
    const shown = JSON.stringify([
      current,
      groups.map(([t, rows]) => [t, rows.map((r) => [r.id, r.label, r.count])]),
    ]);
    if (ifChanged && shown === navShown) return;
    navShown = shown;
    opts.nav.setAttribute(
      "aria-label",
      route.tab === "publish" ? "Publish sections" : "Style sections",
    );
    crumb.replaceChildren();
    title.textContent = "";
    let group = "";
    opts.nav.replaceChildren(...groups.flatMap(([navGroup, rows]) => {
      const h = document.createElement("div");
      h.className = "nh";
      h.textContent = navGroup;
      return [
        h,
        ...rows.map((r) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ni";
          const t = document.createElement("span");
          t.className = r.id.startsWith("is.") ? "t hivis" : "t";
          t.textContent = r.label;
          const k = document.createElement("span");
          k.className = "k";
          k.textContent = r.count ? `${r.count} set` : "";
          b.append(t, k);
          if (r.id === current) {
            b.setAttribute("aria-current", "true");
            group = navGroup;
            title.textContent = r.label;
          }
          b.onclick = () => go(r.route);
          return b;
        }),
      ];
    }));
    crumb.textContent = group;
    drawHere();
  }

  // The styles under the click on the pages that opened the view; one alone
  // is no choice, so the row shows only for two or more.
  function drawHere(): void {
    here.hidden = !trail || trail.steps.length < 2;
    if (!trail || here.hidden) return here.replaceChildren();
    const { steps, key } = trail;
    const catalog = catalogFor(meta);
    const label = document.createElement("span");
    label.textContent = "Styles here";
    here.replaceChildren(
      label,
      ...steps.map((step) => {
        const entry = catalog.find((e) => e.key === step.key);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = entry ? entryName(entry, catalog) : step.key;
        if (step.key === key) b.setAttribute("aria-current", "true");
        b.onmouseenter = () => step.el.setAttribute("data-style-hl", "");
        b.onmouseleave = () => step.el.removeAttribute("data-style-hl");
        b.onclick = () => {
          for (const s of steps) s.el.removeAttribute("data-style-selected");
          step.el.setAttribute("data-style-selected", "");
          go(routeFor(step.key, meta), { steps, key: step.key });
        };
        return b;
      }),
    );
  }

  function build(): Node[] {
    onPages = null;
    const ctx: PanelContext = {
      meta,
      queueSave,
      go,
      preview: opts.preview,
      sheetView: opts.sheetView,
      exportEpub: () => opts.exportEpub(),
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
      case "colors":
        return buildColorsTab(ctx);
      case "publish":
        return buildPublishTab(ctx);
      case "parts":
        return buildPartsTab(ctx, route.part);
    }
  }

  function render(keepScroll = false): void {
    syncIsNames(meta, opts.isNames());
    renderNav();
    const top = body.scrollTop;
    // A hovered "On N pages" button that is replaced never gets its mouseleave.
    for (const e of document.querySelectorAll("[data-style-hl]")) {
      e.removeAttribute("data-style-hl");
    }
    if (route.tab !== "publish") opts.sheetView.replaceChildren();
    body.replaceChildren(...build());
    const on = body.querySelectorAll(".applies");
    where.replaceChildren(...(on.length === 1 ? on : []));
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
    isNamesChanged() {
      syncIsNames(meta, opts.isNames());
      renderNav(true);
    },
    selectStyle(key, path) {
      syncIsNames(meta, opts.isNames());
      go(routeFor(key, meta), path ? { steps: path, key } : null);
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
