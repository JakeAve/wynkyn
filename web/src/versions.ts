// web/src/versions.ts — the History takeover (design-language §6.14). A URL
// state over the mode (`?history=<id|now>`), not a fourth mode: the columns
// become versions | what one changed | its pages, and leaving returns to the
// mode underneath. Pushed builds are held while a version is on the pages.
import type { EditorView } from "@codemirror/view";
import type { RestoreScope, Version } from "../../server/history.ts";
import type { Backend } from "./backend.ts";
import { createHistoryView, whenLabel } from "./history-view.ts";
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
  /** Ended on the way in; `showBook` puts the book's own pages back. */
  themes: { end(): void; showBook(next: UpdateMessage | null): void };
  syncUrl(): void;
  /** Runs `go` as a new history entry, so Back returns to before it. */
  pushPlace(go: () => void): void;
  /** History opened or closed. */
  changed(): void;
}

export interface Versions {
  /** "now" or the version on the pages while History is open, else null. */
  at(): string | null;
  toggle(): void;
  /** False when History isn't open, so esc falls through. */
  escape(): boolean;
  /** A pushed build: true when it is held back from the pages. */
  hold(msg: UpdateMessage): boolean;
  /** The URL's `history`; `back`: there is an entry behind it to return to. */
  follow(at: string | null, back?: boolean): void;
  /** The buffer stands in for the file while it has unsaved edits. */
  snapshot(reason: "close" | "before-reload"): void;
}

export function installVersions(d: VersionsDeps): Versions {
  const root = document.documentElement;
  const panes = $("panes");
  const banner = $("version-banner");
  const toggleBtn = $("history-open") as HTMLButtonElement;
  let at: string | null = null;
  let back = false;
  let view: ReturnType<typeof createHistoryView> | null = null;
  let known: Version[] = [];
  let previewing = false;
  let held: UpdateMessage | null = null;
  let gen = 0;

  // History needs all three columns, so the panes' hidden and expanded
  // classes wait aside while it is open, kept as panes.ts sets them (a mode
  // change re-applies them).
  let paneClasses = "";
  new MutationObserver(() => {
    if (at === null || !panes.className) return;
    paneClasses = panes.className;
    panes.className = "";
  }).observe(panes, { attributeFilter: ["class"] });

  // A version's pages are to look at: no click to the source or a style.
  for (const type of ["click", "mousemove", "dragover", "drop"]) {
    $("preview").addEventListener(type, (e) => {
      if (at === null) return;
      if (type === "dragover" || type === "drop") e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  const say = (kids: (Node | string)[], err = false, action?: Node) => {
    banner.className = err ? "banner err" : "banner";
    banner.replaceChildren(h("span", { class: "msg" }, ...kids));
    if (action) banner.append(action);
    banner.hidden = false;
  };

  const backend = (): Parameters<typeof createHistoryView>[0]["backend"] => {
    const be = d.backend();
    return {
      ...be,
      history: async (book) => known = await be.history(book),
      // Saved first, so the restore's own change reloads a clean buffer
      // rather than raising the changed-on-disk banner.
      restoreVersion: async (book, id, scope) => {
        await d.sync().flush();
        return be.restoreVersion(book, id, scope);
      },
    };
  };

  const bookPages = () => {
    gen++;
    if (!previewing) return;
    previewing = false;
    const next = held;
    held = null;
    d.themes.showBook(next);
  };

  async function show(v: Version | "now"): Promise<void> {
    if (v === "now") {
      banner.hidden = true;
      return bookPages();
    }
    const g = ++gen;
    previewing = true;
    say([
      `Previewing ${
        whenLabel(v, new Date())
      }. Nothing changes until you restore.`,
    ]);
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

  function restored(
    before: Version | null,
    label: string,
    scope: RestoreScope,
  ) {
    at = "now";
    d.syncUrl();
    bookPages();
    if (!before) return say([`Restored ${label}.`]);
    const undo = h("button", { type: "button", class: "btn sm" }, "Undo");
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        await d.sync().flush();
        await d.backend().restoreVersion(d.book(), before.id, scope);
        say(["Restore undone."]);
        await view?.refresh();
      } catch (err) {
        say([h("strong", {}, "Couldn’t undo. "), brief(err)], true);
      }
    };
    say([`Restored ${label}.`], false, undo);
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
        await view?.refresh();
      } catch (x) {
        err.textContent = brief(x);
      }
    };
    dlg.showModal();
    input.focus();
  }

  function enter(first: string) {
    at = first;
    d.themes.end();
    paneClasses = panes.className;
    panes.className = "";
    root.dataset.history = "";
    toggleBtn.setAttribute("aria-pressed", "true");
    d.changed();
    const v = view = createHistoryView({
      list: $("history-list"),
      changes: $("history-changes"),
      backend: backend(),
      book: d.book(),
      edition: d.edition(),
      onSelect(picked) {
        at = picked === "now" ? "now" : picked.id;
        d.syncUrl();
        void show(picked);
      },
      onRestored: restored,
      onName: askName,
    });
    v.refresh().then(() => {
      if (view !== v) return;
      const picked = known.find((x) => x.id === first);
      if (!picked && first !== "now") {
        at = "now"; // an unknown id, from an old link: the book now
        d.syncUrl();
      }
      v.select(picked ? first : "now");
      void show(picked ?? "now");
      $("history-list").querySelector<HTMLElement>('[aria-current="true"]')
        ?.focus();
    }, (err) => {
      if (view === v) {
        say([h("strong", {}, "Couldn’t load History. "), brief(err)], true);
      }
    });
  }

  function exit() {
    at = null;
    back = false;
    view?.destroy();
    view = null;
    delete root.dataset.history;
    panes.className = paneClasses;
    toggleBtn.setAttribute("aria-pressed", "false");
    banner.hidden = true;
    bookPages();
    d.changed();
  }

  function close() {
    if (at === null) return;
    if (back) return history.back(); // popstate follows it out
    exit();
    d.syncUrl();
  }

  const toggle = () => {
    if (at !== null) return close();
    d.pushPlace(() => enter("now"));
    back = true;
  };
  toggleBtn.onclick = toggle;
  $("history-back").onclick = close;
  toggleBtn.disabled = false;

  return {
    at: () => at,
    toggle,
    escape() {
      if (at === null) return false;
      close();
      return true;
    },
    hold(msg) {
      if (!previewing) return false;
      held = msg;
      return true;
    },
    follow(next, behind = true) {
      if (next === null) {
        if (at !== null) exit();
      } else if (at === null) {
        enter(next);
        back = behind;
      } else if (next !== at) {
        at = next;
        view?.select(next);
        void show(known.find((x) => x.id === next) ?? "now");
      }
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
