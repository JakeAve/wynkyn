// web/src/panel-themes.ts — the style panel's Theme view (spec §4.13, §7.5):
// a grid of cards, one per preset theme, each set in the theme's own fonts.
// A book whose look is no theme's gets a Custom card first, its own style. The
// pressed card is the previewed theme, or with none the book's own look. A
// click asks the app to preview the theme; the app marks the previewed card
// back through ConfigPanel.themeTried. `themeCard` is also the new-book
// dialog's, so its CSS works outside the panel too.
import { generateFontLinks } from "../../metadata/css-generator.ts";
import {
  currentTheme,
  type Theme,
  themeLook,
  THEMES,
} from "../../metadata/themes.ts";
import type { Metadata } from "../../metadata/types.ts";
import { formatNumber } from "../../renderer/render.ts";
import type { PanelContext } from "./style-catalog.ts";

const INTRO = "Get started fast by previewing a pre-built theme. A theme " +
  "sets fonts, part styles, chapter numbers and running heads.";
const TITLE = "The Valley of Ashes";
const BODY =
  "In my younger and more vulnerable years my father gave me some advice.";

const loaded = new Set<string>();

// The families the cards use and no link has loaded yet, in one Google Fonts
// link: every theme's the first time a card is built rather than at app start,
// and a Custom card's own (a theme preview swaps the book's links out).
function loadFonts(families: Iterable<string>): void {
  const fresh = [...new Set(families)].filter((f) => !loaded.has(f));
  if (!fresh.length) return;
  for (const f of fresh) loaded.add(f);
  const fonts = Object.fromEntries(fresh.map((f) => [f, f]));
  document.head.insertAdjacentHTML(
    "beforeend",
    generateFontLinks({ fonts } as Metadata),
  );
}

const face = (family: string): string => `"${family}", serif`;

const span = (cls: string, text: string): HTMLSpanElement => {
  const e = document.createElement("span");
  e.className = cls;
  e.textContent = text;
  return e;
};

// A theme's part style on a card: aliases resolved, pt sizes scaled to rem and
// capped, box and line-height properties skipped (they size a page, not a card).
function specimen(
  e: HTMLElement,
  props: Record<string, unknown> | undefined,
  fonts: Record<string, string>,
  cap: number,
): HTMLElement {
  const p = { "font-family": "body", ...props };
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "string") continue;
    if (/^(margin|padding|border|display|line-height|width)/.test(k)) continue;
    if (k === "font-family") e.style.fontFamily = face(fonts[v] ?? v);
    else if (k === "font-size" && v.endsWith("pt")) {
      const px = Math.min(cap, parseFloat(v) * 1.15);
      e.style.fontSize = `${(px / 16).toFixed(3)}rem`; // follows the root
    } else e.style.setProperty(k, v);
  }
  return e;
}

export function themeCard(
  theme: Theme,
  size: "full" | "small",
): HTMLButtonElement {
  loadFonts(THEMES.flatMap((t) => Object.values(themeLook(t.slug).fonts)));
  const b = card(themeLook(theme.slug), theme.slug, theme.name, size);
  if (size === "full") {
    b.lastElementChild!.before(span("tdesc", theme.description));
  }
  return b;
}

// The book's own look as a card, first when it is no theme's: its fonts named.
function customCard(meta: Metadata): HTMLButtonElement {
  const fonts = meta.fonts ?? {};
  loadFonts(Object.values(fonts));
  const b = card({ ...meta, fonts }, "custom", "Custom", "full");
  const body = fonts.body ?? "the default face";
  const display = fonts.display ?? body;
  b.lastElementChild!.replaceWith(span(
    "tdesc",
    `The style you've made for this book: ${body}` +
      (display === body ? "." : ` with ${display} for display.`),
  ));
  return b;
}

function card(
  look: Pick<Metadata, "fonts" | "elements" | "numbering">,
  slug: string,
  title: string,
  size: "full" | "small",
): HTMLButtonElement {
  const fonts = look.fonts ?? {};
  const chapter = (look.elements?.chapter ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const c = look.numbering?.chapters ?? {};
  const label = `${c.prefix ?? ""}${formatNumber(1, c.style ?? "roman-upper")}${
    c.suffix ?? ""
  }`;
  const body = fonts.body ?? "";
  const display = fonts.display ?? body;

  const b = document.createElement("button");
  b.type = "button";
  b.className = size === "small" ? "tcard sm" : "tcard";
  b.dataset.slug = slug;
  b.setAttribute("aria-pressed", "false");
  const name = span("tname", title);
  name.style.fontFamily = face(display);
  const spec = span("tspec", "");
  spec.append(
    specimen(span("tnum", label), chapter.number, fonts, 12),
    specimen(span("ttitle", TITLE), chapter.title, fonts, 17),
  );
  b.append(name, spec);
  if (size === "full") {
    const line = span("tbody", BODY);
    line.style.fontFamily = face(body);
    spec.append(line);
  }
  b.append(span("tpair", body === display ? body : `${body} · ${display}`));
  return b;
}

// Arrow keys move focus across the grid, a row at a time up and down.
export function arrowKeys(grid: HTMLElement): void {
  grid.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key] ??
      (e.key === "ArrowUp" || e.key === "ArrowDown"
        ? (e.key === "ArrowUp" ? -1 : 1) *
          getComputedStyle(grid).gridTemplateColumns.split(" ").length
        : 0);
    if (!step) return;
    const cards = [...grid.querySelectorAll<HTMLElement>(".tcard")];
    const next = cards[cards.indexOf(e.target as HTMLElement) + step];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
}

// Presses the previewed theme's card, or with none the book's own, and shows
// the Previewing row for it.
export function markTried(view: HTMLElement, slug: string | null): void {
  const grid = view.querySelector<HTMLElement>(".tgrid");
  const bar = view.querySelector<HTMLElement>("#theme-bar");
  if (!grid || !bar) return;
  const on = slug ?? grid.dataset.current;
  for (const c of grid.querySelectorAll<HTMLElement>(".tcard")) {
    c.setAttribute("aria-pressed", String(c.dataset.slug === on));
  }
  showThemeBar(bar, slug);
}

// The previewed theme's row, sticky at the top of the Theme view: its name,
// Apply… (the app asks how) and Discard. Hidden while nothing is previewed.
function showThemeBar(bar: HTMLElement, slug: string | null): void {
  bar.hidden = slug === null;
  bar.dataset.slug = slug ?? "";
  bar.querySelector("b")!.textContent =
    THEMES.find((t) => t.slug === slug)?.name ?? "";
}

function themeBar(ctx: PanelContext): HTMLElement {
  const bar = document.createElement("div");
  bar.id = "theme-bar";
  const what = span("what", "Previewing ");
  what.setAttribute("role", "status");
  what.append(document.createElement("b"));
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn primary";
  apply.textContent = "Apply…";
  apply.onclick = () => bar.dataset.slug && ctx.applyTheme(bar.dataset.slug);
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "btn";
  discard.textContent = "Discard";
  discard.onclick = () => ctx.tryTheme(null);
  bar.append(what, apply, discard);
  return bar;
}

export function buildThemesTab(ctx: PanelContext): Node[] {
  const sec = document.createElement("section");
  sec.className = "sec";
  const intro = document.createElement("p");
  intro.className = "tintro";
  intro.textContent = INTRO;
  const grid = document.createElement("div");
  grid.className = "tgrid";
  const current = currentTheme(ctx.meta) ?? "custom";
  grid.dataset.current = current;
  if (current === "custom") grid.append(customCard(ctx.meta));
  grid.append(...THEMES.map((t) => themeCard(t, "full")));
  for (const c of grid.querySelectorAll<HTMLElement>(".tcard")) {
    // The book's own look is what Discard shows; previewing it changes nothing.
    const slug = c.dataset.slug!;
    c.onclick = () => ctx.tryTheme(slug === current ? null : slug);
  }
  arrowKeys(grid);
  sec.append(themeBar(ctx), intro, grid);
  markTried(sec, ctx.themeTried);
  return [sec];
}
