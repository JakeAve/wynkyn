// web/src/panes.ts — the columns' own chrome (spec §7.1, design-language.md
// §7): the Contents toggle, Pages hidden by Mod+. alone, and the write pane and
// the pages expanding from their top-right corner. Hidden columns persist
// (localStorage tree-hidden, pages-hidden); the expanded pane persists per
// mode (expanded:<mode>, "writing" | "pages" | ""). Pages hide in Write only.
import type { Mode } from "./preview.ts";
import { $, store } from "./dom.ts";

type Pane = "writing" | "pages";

export interface Panes {
  toggleTree(): void;
  togglePages(): void;
  toggleExpand(): void;
  /** False when nothing was expanded, so esc can fall through. */
  returnFromExpand(): boolean;
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
  const writeBtn = $("editor").querySelector<HTMLElement>(".expand")!;
  // Pages hidden (Mod+.), the writing's corner button is the way back to them.
  const pagesBack = () =>
    !expanded() && panes.classList.contains("pages-hidden");
  // Expanded, the Contents toggle pins the outline over the view instead.
  const syncButtons = () => {
    treeBtn.setAttribute(
      "aria-pressed",
      String(
        expanded()
          ? panes.classList.contains("pin-outline")
          : !panes.classList.contains("tree-hidden"),
      ),
    );
    const back = pagesBack();
    const label = back ? "Show the pages" : "Expand the writing";
    writeBtn.setAttribute("aria-label", label);
    // The shortcuts' label pass adds the key to the title.
    writeBtn.dataset.command = back ? "toggle-pages" : "expand";
    writeBtn.dataset.title = back ? label : `${label}; esc returns`;
    writeBtn.setAttribute(
      "aria-pressed",
      String(back || expanded() === "writing"),
    );
  };
  // The pages hide in Write only: Style and Publish work on the pages, and
  // have no write pane to carry the way back.
  const applyHidden = () => {
    panes.classList.toggle("tree-hidden", store("tree-hidden") === "1");
    panes.classList.toggle(
      "pages-hidden",
      deps.mode() === "write" && store("pages-hidden") === "1",
    );
    syncButtons();
  };
  const hide = (cls: "tree-hidden" | "pages-hidden", hidden: boolean) => {
    store(cls, hidden ? "1" : "");
    applyHidden();
  };
  const show = (pane: Pane | "") => {
    panes.classList.toggle("expand-writing", pane === "writing");
    panes.classList.toggle("expand-pages", pane === "pages");
    panes.classList.remove("pin-outline");
    document.body.classList.remove("typing");
    for (const b of panes.querySelectorAll<HTMLElement>(".expand")) {
      b.setAttribute("aria-pressed", String(b.dataset.pane === pane));
    }
    syncButtons(); // after: it may press the writing's button for the pages
  };
  const expand = (pane: Pane | "") => {
    show(pane);
    store(`expanded:${deps.mode()}`, pane);
  };
  // Only Write has a write pane; Style and Publish expand the pages alone.
  const restore = () => {
    applyHidden();
    const saved = store(`expanded:${deps.mode()}`);
    show(
      saved === "pages" || (saved === "writing" && deps.mode() === "write")
        ? saved
        : "",
    );
  };
  const togglePages = () => {
    if (deps.mode() === "write") {
      hide("pages-hidden", !panes.classList.contains("pages-hidden"));
    }
  };
  restore();
  new MutationObserver(restore).observe(document.documentElement, {
    attributeFilter: ["data-mode"],
  });

  let last: Pane = "writing"; // the pane Mod+Shift+Enter expands in Write
  $("editor").addEventListener("focusin", () => last = "writing");
  $("pages").addEventListener("pointerdown", () => last = "pages");
  for (const b of panes.querySelectorAll<HTMLElement>(".expand")) {
    b.onclick = () => {
      const pane = b.dataset.pane as Pane;
      if (pane === "writing" && pagesBack()) return togglePages();
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
    syncButtons();
  };
  treeBtn.onclick = toggleTree;

  return {
    toggleTree,
    togglePages,
    toggleExpand: () =>
      expand(expanded() ? "" : deps.mode() === "write" ? last : "pages"),
    returnFromExpand: () => {
      if (!expanded()) return false;
      expand("");
      return true;
    },
  };
}
