// web/src/panes.ts — the columns' own chrome (spec §7.1, design-language.md
// §7): the Contents toggle, Pages hidden by ⌘. alone, and the write pane and
// the pages expanding from their top-right corner. Hidden columns persist
// (localStorage tree-hidden, pages-hidden); the expanded pane persists per
// mode (expanded:<mode>, "writing" | "pages" | "").
import type { Mode } from "./preview.ts";
import { $ } from "./dom.ts";

type Pane = "writing" | "pages";

export interface Panes {
  toggleTree(): void;
  togglePages(): void;
  toggleExpand(): void;
  /** False when nothing was expanded, so esc can fall through. */
  returnFromExpand(): boolean;
}

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the layout just won't survive a reload
  }
  return null;
}

export function installPanes(deps: { mode(): Mode }): Panes {
  const panes = $("panes");
  const treeBtn = $("tree-toggle");
  const expanded = (): Pane | "" =>
    panes.classList.contains("expand-writing")
      ? "writing"
      : panes.classList.contains("expand-pages")
      ? "pages"
      : "";
  // Expanded, the Contents toggle pins the outline over the view instead.
  const syncTreeBtn = () =>
    treeBtn.setAttribute(
      "aria-pressed",
      String(
        expanded()
          ? panes.classList.contains("pin-outline")
          : !panes.classList.contains("tree-hidden"),
      ),
    );
  const hide = (cls: "tree-hidden" | "pages-hidden", hidden: boolean) => {
    panes.classList.toggle(cls, hidden);
    store(cls, hidden ? "1" : "");
    syncTreeBtn();
  };
  const show = (pane: Pane | "") => {
    panes.classList.toggle("expand-writing", pane === "writing");
    panes.classList.toggle("expand-pages", pane === "pages");
    panes.classList.remove("pin-outline");
    document.body.classList.remove("typing");
    for (const b of panes.querySelectorAll<HTMLElement>(".expand")) {
      b.setAttribute("aria-pressed", String(b.dataset.pane === pane));
    }
    syncTreeBtn();
  };
  const expand = (pane: Pane | "") => {
    show(pane);
    store(`expanded:${deps.mode()}`, pane);
  };
  // Only Write has a write pane; Style and Publish expand the pages alone.
  const restore = () => {
    const saved = store(`expanded:${deps.mode()}`);
    show(
      saved === "pages" || (saved === "writing" && deps.mode() === "write")
        ? saved
        : "",
    );
  };
  hide("tree-hidden", store("tree-hidden") === "1");
  hide("pages-hidden", store("pages-hidden") === "1");
  restore();
  new MutationObserver(restore).observe(document.documentElement, {
    attributeFilter: ["data-mode"],
  });

  let last: Pane = "writing"; // the pane ⌘⇧↩ expands in Write
  $("editor").addEventListener("focusin", () => last = "writing");
  $("pages").addEventListener("pointerdown", () => last = "pages");
  for (const b of panes.querySelectorAll<HTMLElement>(".expand")) {
    b.onclick = () => {
      const pane = b.dataset.pane as Pane;
      expand(expanded() === pane ? "" : pane);
    };
  }
  // Writing expanded: the chrome fades while typing, back on a mouse move.
  $("editor").addEventListener("keydown", (e) => {
    if (expanded() === "writing" && !e.metaKey && !e.ctrlKey) {
      document.body.classList.add("typing");
    }
  });
  addEventListener("mousemove", () => document.body.classList.remove("typing"));

  const toggleTree = () => {
    if (!expanded()) {
      return hide("tree-hidden", !panes.classList.contains("tree-hidden"));
    }
    panes.classList.toggle("pin-outline");
    syncTreeBtn();
  };
  treeBtn.onclick = toggleTree;

  return {
    toggleTree,
    togglePages: () =>
      hide("pages-hidden", !panes.classList.contains("pages-hidden")),
    toggleExpand: () =>
      expand(expanded() ? "" : deps.mode() === "write" ? last : "pages"),
    returnFromExpand: () => {
      if (!expanded()) return false;
      expand("");
      return true;
    },
  };
}
