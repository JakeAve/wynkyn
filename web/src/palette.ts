// web/src/palette.ts — the ⌘K palette (spec: command palette): one filtered
// list of commands, sentinels, go-to rows and styles, grouped and ordered by
// mode, recent picks first.
import type { Mode } from "./preview.ts";
import { h } from "./panel-controls.ts";
import { $, store } from "./dom.ts";

export type Group = "Commands" | "Sentinels" | "Go to" | "Styles";

export interface Item {
  id: string;
  label: string;
  group: Group;
  detail?: string;
  keys?: string;
  off?: boolean;
  run(): void;
}

export interface RankContext {
  mode: Mode;
  recent: string[];
  pages: number;
  goToPage(n: number): void;
}

const ORDER: Record<"write" | "other", Group[]> = {
  write: ["Sentinels", "Commands", "Go to", "Styles"],
  other: ["Commands", "Styles", "Go to", "Sentinels"],
};

export function rank(items: Item[], query: string, ctx: RankContext): Item[] {
  let q = query.trim();
  const order = ORDER[ctx.mode === "write" ? "write" : "other"];
  if (!q) {
    const recent = ctx.recent.flatMap((id) =>
      items.find((i) => i.id === id) ?? []
    );
    const rest = items.filter((i) => !recent.includes(i));
    return [...recent, ...sortBy(rest, order)];
  }
  let pool = items;
  if (q.startsWith("{")) {
    pool = items.filter((i) => i.group === "Sentinels");
    q = q.slice(1);
  }
  const f = q.toLowerCase();
  const hits = pool.filter((i) =>
    i.label.toLowerCase().includes(f) ||
    !!i.detail?.toLowerCase().includes(f)
  );
  const page = /^(page\s*)?(\d+)$/i.exec(query.trim());
  if (!page) return sortBy(hits, order);
  const n = Number(page[2]);
  return [{
    id: "page",
    label: `Go to page ${n}`,
    group: "Go to",
    off: n === 0 || n > ctx.pages,
    run: () => ctx.goToPage(n),
  }, ...sortBy(hits, order)];
}

const sortBy = (items: Item[], order: Group[]) =>
  items.toSorted((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

const RECENT = "palette-recent";

function recents(): string[] {
  try {
    const v: unknown = JSON.parse(store(RECENT) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface PaletteDeps {
  items(): Item[];
  mode(): Mode;
  pages(): number;
  goToPage(n: number): void;
}

export function installPalette(
  deps: PaletteDeps,
): { open(query?: string): void } {
  const dlg = $("palette") as HTMLDialogElement;
  const input = $("palette-input") as HTMLInputElement;
  const list = $("palette-list");
  let items: Item[] = [];
  let shown: Item[] = [];
  let on = -1;
  let prev: HTMLElement | null = null;
  let picked = false;

  const step = (from: number, by: number) => {
    for (let k = 1; k <= shown.length; k++) {
      const i = (from + by * k + shown.length * k) % shown.length;
      if (!shown[i]?.off) return i;
    }
    return -1;
  };

  const select = (i: number) => {
    on = i;
    list.querySelectorAll("[role=option]").forEach((r, j) =>
      r.setAttribute("aria-selected", String(j === on))
    );
    const row = list.querySelector<HTMLElement>(`#palette-opt-${on}`);
    if (row) {
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };

  const render = () => {
    const recent = recents();
    shown = rank(items, input.value, {
      mode: deps.mode(),
      recent,
      pages: deps.pages(),
      goToPage: deps.goToPage,
    });
    const lead = input.value.trim()
      ? 0
      : shown.filter((i) => recent.includes(i.id)).length;
    list.replaceChildren();
    let group = "";
    shown.forEach((it, i) => {
      const g = i < lead ? "Recent" : it.group;
      if (g !== group) {
        group = g;
        list.append(h("div", { class: "pl-grp", role: "presentation" }, g));
      }
      const row = h(
        "div",
        {
          id: `palette-opt-${i}`,
          class: "pl-row",
          role: "option",
          "aria-selected": "false",
          "aria-disabled": it.off ? "true" : undefined,
        },
        it.group === "Sentinels"
          ? h("code", { class: "pl-label" }, it.label)
          : h("span", { class: "pl-label" }, it.label),
        h("span", { class: "pl-detail" }, it.detail ?? ""),
        ...(it.keys ? [h("kbd", {}, it.keys)] : []),
      );
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = () => pick(it);
      list.append(row);
    });
    if (!shown.length) {
      list.append(h("p", { class: "pl-none" }, "No matches"));
    }
    select(step(-1, 1));
  };

  const pick = (it: Item | undefined) => {
    if (!it || it.off) return;
    picked = true;
    dlg.close();
    prev?.focus();
    if (it.id !== "page") {
      store(
        RECENT,
        JSON.stringify([it.id, ...recents().filter((x) => x !== it.id)]
          .slice(0, 5)),
      );
    }
    it.run();
  };

  input.oninput = render;
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      select(step(on, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") pick(shown[on]);
    else return;
    e.preventDefault();
  };
  dlg.addEventListener("close", () => {
    if (!picked) prev?.focus();
  });

  return {
    open(query = "") {
      if (!dlg.open) {
        prev = document.activeElement as HTMLElement | null;
        picked = false;
        items = deps.items();
        dlg.showModal();
      }
      input.value = query;
      render();
      input.focus();
      input.setSelectionRange(query.length, query.length);
    },
  };
}
