// web/src/font-picker.ts — the Fonts tab's typeface picker (spec §7.5
// "searchable picker"): a button showing the family, opening a popup with a
// search box, category filters and every Google family and installed font
// drawn in its own face (§4.4). The curated book faces lead; any name can
// still be typed in and used.
import {
  FONT_CATALOG,
  type FontCategory,
  GOOGLE_FAMILIES,
} from "../../metadata/fonts-catalog.ts";
import { GOOGLE_FONTS } from "./fonts-list.ts";
import { h, icon, seg } from "./panel-controls.ts";

const CATEGORY = new Map(FONT_CATALOG);
const CURATED = new Set(GOOGLE_FONTS);
const OTHER_GOOGLE = FONT_CATALOG.map(([f]) => f).filter((f) =>
  !CURATED.has(f)
);

// Installed fonts not also on Google, from the dev server; asked once per
// page load (reload after installing a font).
let installedList: Promise<string[]> | undefined;
function installed(): Promise<string[]> {
  return installedList ??= fetch("/api/fonts")
    .then((r) => r.ok ? r.json() : { installed: [] })
    .then((j: { installed: string[] }) =>
      j.installed.filter((f) => !GOOGLE_FAMILIES.has(f))
    )
    .catch(() => []);
}

/** Neither a Google family nor installed: Chrome will draw a fallback. */
export async function fontMissing(family: string): Promise<boolean> {
  return !!family && !GOOGLE_FAMILIES.has(family) &&
    !(await installed()).includes(family);
}
const FILTERS: Array<{ value: FontCategory | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans" },
  { value: "display", label: "Display" },
  { value: "script", label: "Script" },
  { value: "mono", label: "Mono" },
];

// Each name is drawn from a css2 subset holding only its own letters, loaded
// once as it scrolls into view. The face is registered as "pick <family>" so
// a partial font never stands in for the book's own copy of that family.
// Installed fonts need no loading: their own name finds them.
const loaded = new Set<string>();
function previewFace(family: string): string {
  if (!GOOGLE_FAMILIES.has(family)) return `"${family}", system-ui, sans-serif`;
  if (!loaded.has(family)) {
    loaded.add(family);
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    const text = encodeURIComponent([...new Set(family)].join(""));
    fetch(`https://fonts.googleapis.com/css2?family=${name}&text=${text}`)
      .then((r) => r.ok ? r.text() : "")
      .then((css) => {
        const style = document.createElement("style");
        style.textContent = css.replace(
          /font-family: '([^']+)'/g,
          "font-family: 'pick $1'",
        );
        document.head.append(style);
      })
      .catch(() => {}); // offline: the name shows in the fallback face
  }
  return `"pick ${family}", system-ui, sans-serif`;
}

export function fontPicker(
  current: string,
  label: string,
  onPick: (family: string) => void,
): HTMLElement {
  const name = h("span", { class: "fam" });
  const btn = h(
    "button",
    {
      type: "button",
      class: "fontbtn",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-label": label,
    },
    name,
    icon("chevD"),
  );
  const show = (family: string) => {
    name.textContent = family || "Choose a typeface";
    name.style.fontFamily = family ? previewFace(family) : "";
  };
  show(current);

  const wrap = h("div", { class: "fontpick" }, btn);
  let pop: HTMLElement | null = null;

  function close(): void {
    pop?.remove();
    pop = null;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", outside);
  }
  function outside(e: MouseEvent): void {
    if (!wrap.contains(e.target as Node)) close();
  }
  function pick(family: string): void {
    close();
    btn.focus();
    if (!family || family === current) return;
    current = family;
    show(family);
    onPick(family);
  }

  function open(local: string[]): void {
    const input = h("input", {
      type: "search",
      class: "find",
      placeholder: `Search ${
        (FONT_CATALOG.length + local.length).toLocaleString()
      } fonts`,
      "aria-label": "Search fonts",
      spellcheck: "false",
    });
    const list = h("ul", { role: "listbox", "aria-label": label });
    const typed = h("li", { role: "option", class: "typed" });
    let cat: FontCategory | "all" = "all";
    let shown: HTMLElement[] = [];
    let on = 0;

    const seen = new IntersectionObserver((hits) => {
      for (const hit of hits) {
        if (!hit.isIntersecting) continue;
        const li = hit.target as HTMLElement;
        li.style.fontFamily = previewFace(li.dataset.family!);
        seen.unobserve(li);
      }
    }, { root: list, rootMargin: "200px 0px" });

    const groups = ([
      ["For books", GOOGLE_FONTS],
      ["On this Mac", local],
      ["Google Fonts", OTHER_GOOGLE],
    ] as const).map(([title, families]) => ({
      head: h("li", { class: "grp", "aria-hidden": "true" }, title),
      rows: families.map((f) => {
        const li = h("li", { role: "option", "data-family": f }, f);
        li.onmousedown = (e) => e.preventDefault(); // keep the search focused
        li.onclick = () => pick(f);
        return li;
      }),
    }));
    typed.onmousedown = (e) => e.preventDefault();
    typed.onclick = () => pick(input.value.trim());
    list.append(...groups.flatMap((g) => [g.head, ...g.rows]), typed);

    const mark = () => {
      shown.forEach((li, i) =>
        li.setAttribute("aria-selected", String(i === on))
      );
      shown[on]?.scrollIntoView({ block: "nearest" });
    };
    const filter = () => {
      const q = input.value.trim().toLowerCase();
      shown = [];
      for (const g of groups) {
        let any = false;
        for (const li of g.rows) {
          const f = li.dataset.family!;
          li.hidden = !f.toLowerCase().includes(q) ||
            (cat !== "all" && CATEGORY.get(f) !== cat);
          if (!li.hidden) shown.push(li), any = true;
        }
        g.head.hidden = !any;
      }
      // No match: a family Google added after the catalog was made.
      typed.hidden = !q || shown.length > 0;
      typed.textContent = `Use “${input.value.trim()}”`;
      if (!typed.hidden) shown.push(typed);
      on = 0;
      mark();
    };

    input.oninput = filter;
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        on = (on + (e.key === "ArrowDown" ? 1 : -1) + shown.length) %
          Math.max(shown.length, 1);
        mark();
      } else if (e.key === "Enter") shown[on]?.click();
      else if (e.key === "Escape") pick("");
      else return;
      e.preventDefault();
    };

    pop = h(
      "div",
      { class: "fontpop" },
      input,
      seg(FILTERS, "all", (v) => {
        cat = v ?? "all";
        filter();
        input.focus();
      }, "Font category"),
      list,
    );
    wrap.append(pop);
    // The list is the observer's root, so rows are watched once it is placed.
    for (const g of groups) g.rows.forEach((li) => seen.observe(li));
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside);
    filter();
    // Open on the current family, so its neighbours are in view.
    const cur = shown.findIndex((li) => li.dataset.family === current);
    if (cur >= 0) {
      on = cur;
      mark();
    }
    pop.scrollIntoView({ block: "nearest" }); // the panel scrolls to fit it
    input.focus({ preventScroll: true });
  }

  btn.onclick = async () => pop ? close() : open(await installed());
  return wrap;
}
