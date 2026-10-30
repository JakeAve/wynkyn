// web/src/versions.ts — History (design-language §6.14, spec §7.10): the
// toolbar's menu of versions; a picked version (`?history=<id>`) on the pages,
// with what it changed in place of the editor's columns, so nothing can be
// edited meanwhile. Pushed builds are held while it shows.
import type { EditorView } from "@codemirror/view";
import type { RestoreScope, Version } from "../../server/history.ts";
import type { Backend } from "./backend.ts";
import {
  createHistoryView,
  nameLabel,
  rowLabel,
  whenLabel,
} from "./history-view.ts";
import type { UpdateMessage } from "./preview.ts";
import type { Sync } from "./sync.ts";
import { h } from "./panel-controls.ts";
import { $, brief } from "./dom.ts";

export interface VersionsDeps {
  backend(): Backend;
  book(): string;
  edition(): string | null;
  sync(): Sync;
  editor(): EditorView;
  /** A version's pages, kept out of the book's cached render. */
  paint(msg: UpdateMessage, cacheKey: null): void;
  /** Ended by a preview; `showBook` puts the book's own pages back. */
  themes: { end(): void; showBook(next: UpdateMessage | null): void };
  syncUrl(): void;
  /** Runs `go` as a new history entry, so Back returns to before it. */
  pushPlace(go: () => void): void;
  /** A preview started or ended. */
  changed(): void;
}

export interface Versions {
  /** The version on the pages, or null for the book now. */
  at(): string | null;
  /** False when there was nothing to close, so esc falls through. */
  escape(): boolean;
  /** A pushed build: true when it is held back from the pages. */
  hold(msg: UpdateMessage): boolean;
  /** The URL's `history`; `back`: there is an entry behind it to return to. */
  follow(at: string | null, back?: boolean): Promise<void>;
  /** The buffer stands in for the file while it has unsaved edits. */
  snapshot(reason: "close" | "before-reload"): void;
}

export function installVersions(d: VersionsDeps): Versions {
  const root = document.documentElement;
  const panes = $("panes");
  const banner = $("version-banner");
  const btn = $("history-open") as HTMLButtonElement;
  const menu = $("history-menu");
  let at: string | null = null;
  let back = false;
  let known: Version[] = [];
  let held: UpdateMessage | null = null;
  let gen = 0;
  let follows = 0; // only the latest Back/Forward or link acts
  let restoredShown = false;

  const pressed = () =>
    btn.setAttribute(
      "aria-pressed",
      String(at !== null || menu.matches(":popover-open")),
    );

  // The panes' hidden and expanded classes wait aside during a preview, kept
  // as panes.ts last set them, and come back with editing.
  let paneClasses = "";
  const setAside = () => {
    paneClasses = panes.className;
    panes.className = "";
  };
  new MutationObserver(() => {
    if (at !== null && panes.className) setAside();
  }).observe(panes, { attributeFilter: ["class"] });
  // Nothing is edited under a preview: the modes and the Contents toggle
  // hold, and the middle gutter would resize a column that isn't showing.
  const lock = (on: boolean) => {
    for (const b of $("modes").querySelectorAll("button")) b.disabled = on;
    ($("tree-toggle") as HTMLButtonElement).disabled = on;
    $("gutter-editor").inert = on;
  };
  // Hidden, a list loses its scroll position (CodeMirror keeps its own).
  let scrolls: [Element, number][] = [];

  // A version's pages are to look at: no click to the source or a style.
  for (const type of ["click", "mousemove", "dragover", "drop"]) {
    $("preview").addEventListener(type, (e) => {
      if (at === null) return;
      if (type === "dragover" || type === "drop") e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  const button = (label: string, run: () => void, cls = "btn sm") => {
    const b = h("button", { type: "button", class: cls }, label);
    b.onclick = run;
    return b;
  };
  const say = (kids: (Node | string)[], err = false, actions: Node[] = []) => {
    banner.className = err ? "banner err" : "banner";
    banner.replaceChildren(h("span", { class: "msg" }, ...kids), ...actions);
    banner.hidden = false;
    restoredShown = false;
  };
  const dismiss = () => {
    const x = button("✕", () => banner.hidden = true, "btn sm icon");
    x.setAttribute("aria-label", "Dismiss");
    return x;
  };

  const be = d.backend();
  const view = createHistoryView({
    list: $("history-list"),
    changes: $("history-diff"),
    backend: {
      ...be,
      history: async (book) => known = await be.history(book),
      // Saved first, so the restore's own change reloads a clean buffer
      // rather than raising the changed-on-disk banner.
      restoreVersion: async (book, id, scope) => {
        await d.sync().flush();
        return be.restoreVersion(book, id, scope);
      },
    },
    book: d.book(),
    edition: d.edition(),
    onSelect(picked) {
      menu.hidePopover();
      if (picked === "now") return backToNow();
      if (at !== null) {
        start(picked);
        return d.syncUrl();
      }
      d.pushPlace(() => start(picked));
      back = true;
    },
    onRestored: restored,
    onName: askName,
  });

  const bookPages = () => {
    gen++;
    const next = held;
    held = null;
    d.themes.showBook(next);
  };

  function start(v: Version) {
    follows++;
    if (at === null) {
      d.themes.end();
      scrolls = [
        ...document.querySelectorAll(
          "#tree, #style-nav, #config-overlay .pbody",
        ),
      ].map((el) => [el, el.scrollTop]);
      setAside();
      lock(true);
      root.dataset.history = "";
    }
    at = v.id;
    view.select(v.id);
    pressed();
    d.changed();
    void show(v);
  }

  async function show(v: Version) {
    const g = ++gen;
    const what = v.name ?? rowLabel(v, d.edition()).head;
    say(
      [
        `Previewing ${what}, ${whenLabel(v, new Date())}. ` +
        "Nothing changes until you restore.",
      ],
    );
    try {
      const built = await d.backend().buildVersion(d.book(), v.id, d.edition());
      if (g !== gen) return;
      // Its text may not be the buffer's, which would leave it dimmed.
      delete $("preview").dataset.stale;
      d.paint({ ...built, type: "update" }, null);
    } catch (err) {
      if (g === gen) {
        say(
          [h("strong", {}, "Couldn’t show this version. "), brief(err)],
          true,
        );
      }
    }
  }

  function end() {
    follows++;
    if (at === null) return;
    at = null;
    back = false;
    delete root.dataset.history;
    panes.className = paneClasses;
    lock(false);
    for (const [el, top] of scrolls) el.scrollTop = top;
    view.select("now");
    if (!restoredShown) banner.hidden = true;
    bookPages();
    pressed();
    d.changed();
  }

  function backToNow() {
    if (at === null) return;
    if (back) return history.back(); // popstate follows it out
    end();
    d.syncUrl();
  }

  function restored(
    before: Version | null,
    label: string,
    scope: RestoreScope,
  ) {
    const undo = before && button("Undo", async () => {
      undo!.disabled = true;
      try {
        await d.sync().flush();
        await d.backend().restoreVersion(d.book(), before.id, scope);
        say(["Restore undone."], false, [dismiss()]);
        await view.refresh();
      } catch (err) {
        say([h("strong", {}, "Couldn’t undo. "), brief(err)], true, [
          dismiss(),
        ]);
      }
    });
    say([`Restored ${label}.`], false, [...undo ? [undo] : [], dismiss()]);
    restoredShown = true;
    backToNow();
  }

  function askName(target: Version | "now") {
    const dlg = $("name-dlg") as HTMLDialogElement;
    const input = $("name-input") as HTMLInputElement;
    const err = $("name-err");
    input.value = target === "now" ? "" : target.name ?? "";
    $("name-dlg-title").textContent =
      target !== "now" && target.name !== undefined
        ? "Rename this version"
        : "Name this version";
    err.textContent = "";
    $("name-cancel").onclick = () => dlg.close();
    ($("name-form") as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      try {
        // Naming now names what is on disk, so the last edits go there first.
        if (target === "now") await d.sync().flush();
        await d.backend().nameVersion(
          d.book(),
          target === "now" ? null : target.id,
          name,
        );
        dlg.close();
        await view.refresh();
      } catch (x) {
        err.textContent = brief(x);
      }
    };
    dlg.showModal();
    input.focus();
  }

  menu.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom}px`;
    menu.style.right = `${innerWidth - r.right}px`;
    $("history-name").textContent = nameLabel(
      known.find((v) => v.id === at) ?? "now",
    );
    view.refresh().then(
      () => menu.querySelector<HTMLElement>('[aria-current="true"]')?.focus(),
      (err) =>
        say([h("strong", {}, "Couldn’t load History. "), brief(err)], true, [
          dismiss(),
        ]),
    );
  });
  menu.addEventListener("toggle", pressed);
  // Listed ahead of a click, so the menu opens filled.
  for (const type of ["pointerenter", "focus"]) {
    btn.addEventListener(type, () => void view.refresh().catch(() => {}));
  }
  $("history-name").onclick = () => {
    menu.hidePopover();
    askName(known.find((v) => v.id === at) ?? "now");
  };
  $("history-changes-close").onclick = backToNow;
  btn.disabled = false;

  return {
    at: () => at,
    escape() {
      if (at === null) return false;
      backToNow();
      return true;
    },
    hold(msg) {
      if (at === null) return false;
      held = msg;
      return true;
    },
    async follow(next, behind = true) {
      if (next === null) return end();
      if (next === at) return;
      const mine = ++follows;
      if (!known.some((x) => x.id === next)) {
        await view.refresh().catch(() => {});
        if (mine !== follows) return;
      }
      const v = known.find((x) => x.id === next);
      if (!v) {
        end();
        return d.syncUrl(); // an unknown id, from an old link: the book now
      }
      if (at === null) back = behind;
      start(v);
    },
    snapshot(reason) {
      const sync = d.sync();
      const unsaved = sync.manuscriptDirty() || sync.manuscriptBusy();
      d.backend().takeSnapshot(
        d.book(),
        reason,
        unsaved
          ? { "manuscript.md": d.editor().state.doc.toString() }
          : undefined,
      ).catch(() => {}); // a missed snapshot must never stop the editor
    },
  };
}
