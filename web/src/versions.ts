// web/src/versions.ts — History (design-language §6.14, spec §7.10): the
// toolbar's menu of versions, a version previewed on the pages
// (`?history=<id>`) while the editor's own columns stay, and every change it
// made in the middle column on request. Pushed builds are held meanwhile.
import type { EditorView } from "@codemirror/view";
import type { RestoreScope, Version } from "../../server/history.ts";
import type { Backend } from "./backend.ts";
import { createHistoryView, rowLabel, whenLabel } from "./history-view.ts";
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

// What hides the pages or the middle column, set aside during a preview.
const HIDING = ["pages-hidden", "expand-writing", "expand-pages"];

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
  let restoredShown = false;

  const pressed = () =>
    btn.setAttribute(
      "aria-pressed",
      String(at !== null || menu.matches(":popover-open")),
    );

  // Kept as panes.ts last set them (a mode change re-applies them), and put
  // back when the preview ends.
  let paneClasses = "";
  const setAside = () => {
    paneClasses = panes.className;
    panes.classList.remove(...HIDING);
  };
  new MutationObserver(() => {
    if (at !== null && HIDING.some((c) => panes.classList.contains(c))) {
      setAside();
    }
  }).observe(panes, { attributeFilter: ["class"] });

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
    if (at === null) {
      d.themes.end();
      setAside();
      root.dataset.history = "preview";
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
      false,
      [button("Back to now", backToNow), ...view.restoreControl()],
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
          [
            button("Back to now", backToNow),
          ],
        );
      }
    }
  }

  function end() {
    if (at === null) return;
    at = null;
    back = false;
    delete root.dataset.history;
    panes.className = paneClasses;
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
    view.refresh().then(
      () => menu.querySelector<HTMLElement>('[aria-current="true"]')?.focus(),
      (err) =>
        say([h("strong", {}, "Couldn’t load History. "), brief(err)], true, [
          dismiss(),
        ]),
    );
  });
  menu.addEventListener("toggle", pressed);
  $("history-name").onclick = () => {
    menu.hidePopover();
    askName(known.find((v) => v.id === at) ?? "now");
  };
  // With nothing previewed, the newest version listed.
  $("history-changes-open").onclick = () => {
    const id = at ??
      menu.querySelector<HTMLElement>('.h-row:not([data-id="now"])')?.dataset
        .id;
    const v = known.find((x) => x.id === id);
    if (!v) return;
    menu.hidePopover();
    if (at === null) {
      d.pushPlace(() => start(v));
      back = true;
    }
    root.dataset.history = "changes";
  };
  $("history-changes-close").onclick = () => root.dataset.history = "preview";
  btn.disabled = false;

  return {
    at: () => at,
    escape() {
      if (root.dataset.history === "changes") {
        root.dataset.history = "preview";
      } else if (at !== null) backToNow();
      else if (!banner.hidden) banner.hidden = true;
      else return false;
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
      if (!known.some((x) => x.id === next)) {
        await view.refresh().catch(() => {});
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
