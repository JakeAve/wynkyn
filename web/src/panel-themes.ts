// web/src/panel-themes.ts — the style panel's Theme view (spec §4.13, §7.5):
// a grid of cards, one per preset theme, each set in the theme's own fonts.
// A click asks the app to preview the theme; the app marks the previewed card
// back through ConfigPanel.themeTried. `themeCard` is also the new-book
// dialog's, so its CSS works outside the panel too.
import { generateFontLinks } from "../../metadata/css-generator.ts";
import { type Theme, themeLook, THEMES } from "../../metadata/themes.ts";
import type { Metadata } from "../../metadata/types.ts";
import { formatNumber } from "../../renderer/render.ts";
import type { PanelContext } from "./style-catalog.ts";

const INTRO = "Pick a theme to preview it on your pages. Nothing changes " +
  "until you apply it. A theme sets fonts, part styles, chapter numbers " +
  "and running heads; your page size, margins and custom styles stay.";
const TITLE = "The Valley of Ashes";
const BODY =
  "In my younger and more vulnerable years my father gave me some advice.";

let fontsLoaded = false;

// Every family the cards use, in one Google Fonts link, the first time a card
// is built rather than at app start.
function loadFonts(): void {
  if (fontsLoaded) return;
  fontsLoaded = true;
  const families = new Set(
    THEMES.flatMap((t) => Object.values(themeLook(t.slug).fonts)),
  );
  const fonts = Object.fromEntries([...families].map((f) => [f, f]));
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

// A theme's part style on a card: aliases resolved, pt sizes scaled to px and
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
      e.style.fontSize = `${Math.min(cap, parseFloat(v) * 1.15).toFixed(1)}px`;
    } else e.style.setProperty(k, v);
  }
  return e;
}

export function themeCard(
  theme: Theme,
  size: "full" | "small",
): HTMLButtonElement {
  loadFonts();
  const look = themeLook(theme.slug);
  const { fonts } = look;
  const chapter = (look.elements.chapter ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const c = look.numbering.chapters ?? {};
  const label = `${c.prefix ?? ""}${formatNumber(1, c.style ?? "roman-upper")}${
    c.suffix ?? ""
  }`;
  const body = fonts.body ?? "";
  const display = fonts.display ?? body;

  const b = document.createElement("button");
  b.type = "button";
  b.className = size === "small" ? "tcard sm" : "tcard";
  b.dataset.slug = theme.slug;
  b.setAttribute("aria-pressed", "false");
  const name = span("tname", theme.name);
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
    b.append(span("tdesc", theme.description));
  }
  b.append(span("tpair", body === display ? body : `${body} · ${display}`));
  return b;
}

// Arrow keys move focus across the grid, a row at a time up and down.
function arrowKeys(grid: HTMLElement): void {
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

export function buildThemesTab(ctx: PanelContext): Node[] {
  const sec = document.createElement("section");
  sec.className = "sec";
  const intro = document.createElement("p");
  intro.className = "tintro";
  intro.textContent = INTRO;
  const grid = document.createElement("div");
  grid.className = "tgrid";
  for (const t of THEMES) {
    const card = themeCard(t, "full");
    card.setAttribute("aria-pressed", String(t.slug === ctx.themeTried));
    card.onclick = () => ctx.tryTheme(t.slug);
    grid.append(card);
  }
  arrowKeys(grid);
  sec.append(intro, grid);
  return [sec];
}
