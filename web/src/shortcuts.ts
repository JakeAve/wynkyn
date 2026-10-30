// web/src/shortcuts.ts — every app shortcut (spec §7, shortcuts): one command
// table, one capture-phase keydown, and the label pass that writes each key
// into the chrome from `data-command`. Overrides are per browser, localStorage
// `keys`: JSON { id: "ctrl+b" }, where "" unbinds.
import type { EditorView } from "@codemirror/view";
import { combo, type Command, type Keymap, label, resolve } from "./keys.ts";
import { insertSnippet, openPalette } from "./editor-insert.ts";
import { SNIPPETS } from "./snippets.ts";
import { type Mode, stepPreview } from "./preview.ts";
import type { Panes } from "./panes.ts";
import type { TextView } from "./text-view.ts";
import { store } from "./dom.ts";
// The dialog imports only this module's types, so there is no runtime cycle.
import { installShortcutsDialog } from "./shortcuts-dialog.ts";

export interface Shortcuts {
  commands(): Command[];
  keymap(): Keymap;
  /** The first key's label, "" when unbound. */
  keyLabel(id: string): string;
  /** null restores the default; "" unbinds. */
  bind(id: string, combo: string | null): void;
}

export interface ShortcutDeps {
  mode(): Mode;
  panes: Panes;
  textView: TextView;
  inspect: { escape(): boolean };
  /** `open`: a version is previewed, and nothing may edit the book. */
  history: { open(): boolean; escape(): boolean };
  editor(): EditorView;
  /** The pages pane, `#preview`. */
  preview: HTMLElement;
  /** The new-book dialog; `true` lets it be cancelled. */
  createManuscript(cancelable: boolean): void;
  /** The Style/Publish panel, built on first use. */
  ensureConfigPanel(): Promise<{ open(view: string): void } | null>;
}

// Open popups esc closes first: a dialog, the find bar, completions, the
// sentinel palette and wrap bar, menus (the zoom menu is a popover). Not
// hover tooltips (spelling, lint).
const POPUPS =
  "dialog[open], [popover]:popover-open, .cm-tooltip-autocomplete, .cm-bml-find, .cm-bml-palette, .cm-bml-wrapbar:not(.cm-bml-spell), .fontpop, .tvpop:not([hidden])";

// What may run while a version is previewed: nothing that edits the book or
// moves the editing place under it.
const IN_PREVIEW = new Set([
  "history",
  "theme",
  "shortcuts",
  "zoom-in",
  "zoom-out",
  "zoom-fit",
  "page-next",
  "page-prev",
  "chapter-next",
  "chapter-prev",
]);

// A command that mirrors a button clicks it, so the behaviour never forks; it
// runs while the button is shown and enabled.
function button(sel: string): Pick<Command, "when" | "run"> {
  const el = () => document.querySelector<HTMLButtonElement>(sel);
  return {
    when: () => {
      const b = el();
      return !!b && !b.disabled && b.checkVisibility();
    },
    run: () => el()?.click(),
  };
}

function table(d: ShortcutDeps): Command[] {
  const write = () => d.mode() === "write";
  // A Writing key edits the manuscript, so another text field (the find bar,
  // a filter) keeps it: only the editor or no field at all.
  const writing = () => {
    const a = document.activeElement;
    return write() && (!(a instanceof HTMLElement) ||
      d.editor().contentDOM.contains(a) ||
      !(a.matches("input, textarea, select") || a.isContentEditable));
  };
  const mode = (id: Mode, label: string, keys: string): Command => ({
    id: `mode-${id}`,
    label,
    section: "Modes",
    keys,
    ...button(`#modes [data-mode="${id}"]`),
  });
  const snippet = (id: string, label: string, keys: string): Command => ({
    id,
    label,
    section: "Writing",
    keys,
    when: writing,
    run: () => insertSnippet(d.editor(), SNIPPETS.find((s) => s.label === id)!),
  });
  // A text field keeps its own Mod+Z, the editor included, but not the
  // panel's: they commit on change, so there it means the last edit.
  const undoable = () => {
    const a = document.activeElement;
    return !(a instanceof HTMLTextAreaElement ||
      (a instanceof HTMLElement && a.isContentEditable) ||
      (a instanceof HTMLInputElement && a.type === "text" &&
        !a.closest("#config-overlay")));
  };
  const undoB = button("#undo");
  const redoB = button("#redo");
  const switcher = button("#book-switcher");
  const zoomIn = button('[data-zoom="in"]');
  const step = (
    id: string,
    label: string,
    keys: string,
    dir: 1 | -1,
    unit: "page" | "chapter",
  ): Command => ({
    id,
    label,
    section: "Preview",
    keys: `alt+${keys}`,
    mac: `ctrl+${keys}`,
    when: () => d.preview.checkVisibility(),
    run: () => stepPreview(d.preview, dir, unit),
  });
  const view = (
    id: string,
    label: string,
    nav: string,
    n: string,
  ): Command => ({
    id,
    label,
    section: "Style",
    keys: `mod+shift+${n}`,
    mac: `alt+cmd+${n}`,
    when: () => d.mode() === "style",
    run: () => void d.ensureConfigPanel().then((p) => p?.open(nav)),
  });
  return [
    mode("write", "Write", "mod+1"),
    mode("style", "Style", "mod+2, mod+comma"),
    mode("publish", "Publish", "mod+3"),
    {
      id: "toggle-tree",
      label: "Contents",
      section: "Panes",
      keys: "mod+backslash",
      ...button("#tree-toggle"),
    },
    {
      id: "toggle-pages",
      label: "Pages (Write)",
      section: "Panes",
      keys: "mod+period",
      run: () => d.panes.togglePages(),
    },
    {
      id: "expand",
      label: "Expand / return",
      section: "Panes",
      keys: "mod+shift+enter",
      run: () => d.panes.toggleExpand(),
    },
    // Capture phase, so CodeMirror's toggle comment never sees it.
    {
      id: "prose-source",
      label: "Prose / Source",
      section: "Writing",
      keys: "mod+slash",
      when: write,
      run: () => d.textView.toggleView(),
    },
    // mod+i first: it is the one the wrap bar shows.
    snippet("em", "Emphasis", "mod+i, mod+e"),
    snippet("chapter", "Chapter", "mod+shift+c"),
    snippet("heading", "Heading", "mod+shift+h"),
    snippet("footnote", "Footnote", "mod+shift+f"),
    snippet("quote", "Quote", "mod+shift+q"),
    snippet("break", "Break", "mod+shift+b"),
    {
      id: "sentinel-list",
      label: "Insert sentinel (list)",
      section: "Writing",
      keys: "mod+k",
      when: writing,
      run: () => openPalette(d.editor()),
    },
    {
      id: "theme",
      label: "Light / dark",
      section: "App",
      keys: "mod+shift+l",
      ...button("#theme-toggle"),
    },
    // ⌘⇧Y is taken on a Mac (Services: Make Sticky Note).
    {
      id: "history",
      label: "History",
      section: "App",
      keys: "mod+shift+y",
      mac: "alt+cmd+y",
      ...button("#history-open"),
    },
    {
      id: "switch-book",
      label: "Switch book",
      section: "Book",
      keys: "mod+o",
      ...switcher,
    },
    {
      id: "new-book",
      label: "New book",
      section: "Book",
      // ponytail: Ctrl+Alt is AltGr on Windows, so on some layouts this types
      // a character (Polish ń) instead; rebindable in the dialog.
      keys: "mod+alt+n",
      when: switcher.when,
      run: () => d.createManuscript(true),
    },
    // Only while the zoom buttons are shown (the pages are); otherwise the
    // browser zooms as usual.
    {
      id: "zoom-in",
      label: "Zoom in",
      section: "Preview",
      keys: "mod+equal",
      ...zoomIn,
    },
    {
      id: "zoom-out",
      label: "Zoom out",
      section: "Preview",
      keys: "mod+minus",
      ...button('[data-zoom="out"]'),
    },
    // Fit spread sits in the zoom menu, shown or not.
    {
      id: "zoom-fit",
      label: "Fit spread",
      section: "Preview",
      keys: "mod+0",
      when: zoomIn.when,
      run: () =>
        document.querySelector<HTMLElement>('[data-fit="spread"]')?.click(),
    },
    // ⌥] and ⌥[ type ’ and ‘ on a Mac, so the Mac steps with ⌃.
    step("page-next", "Next page", "bracketright", 1, "page"),
    step("page-prev", "Previous page", "bracketleft", -1, "page"),
    step("chapter-next", "Next chapter", "shift+bracketright", 1, "chapter"),
    step(
      "chapter-prev",
      "Previous chapter",
      "shift+bracketleft",
      -1,
      "chapter",
    ),
    {
      id: "inspect",
      label: "Inspect",
      section: "Preview",
      keys: "mod+quote",
      ...button("#inspect"),
    },
    // Mod+P stays the browser's print: a second print key would confuse.
    // The button exists only in Publish, so being shown scopes it.
    {
      id: "export-epub",
      label: "Export EPUB",
      section: "Publish",
      keys: "mod+shift+e",
      ...button('[data-command="export-epub"]'),
    },
    {
      id: "undo",
      label: "Undo",
      section: "App",
      keys: "mod+z",
      when: () => undoable() && undoB.when!(),
      run: undoB.run,
    },
    {
      id: "redo",
      label: "Redo",
      section: "App",
      keys: "mod+shift+z",
      win: "ctrl+y, ctrl+shift+z",
      when: () => undoable() && redoB.when!(),
      run: redoB.run,
    },
    // macOS keeps ⌘⇧3 and ⌘⇧4 for screenshots, so the Mac set is ⌥⌘1–4.
    view("style-theme", "Theme", "themes", "1"),
    view("style-page", "Page size & margins", "page", "2"),
    view("style-fonts", "Fonts", "fonts", "3"),
    view("style-body", "Body", "body", "4"),
  ];
}

function overrides(): Record<string, string> {
  try {
    const o: unknown = JSON.parse(store("keys") ?? "{}");
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    return Object.fromEntries(
      Object.entries(o).filter(([, v]) => typeof v === "string"),
    );
  } catch {
    return {}; // not JSON: start from the defaults
  }
}

// aria-keyshortcuts names modifiers the ARIA way and keys as they print.
const ARIA: Record<string, string> = {
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  cmd: "Meta",
};
const aria = (c: string) =>
  c.split("+").map((p, i, a) =>
    i < a.length - 1 ? ARIA[p] ?? p : label(p, false)
  ).join("+");

export function installShortcuts(deps: ShortcutDeps): Shortcuts {
  let openDialog = () => {};
  const commands: Command[] = [
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      section: "App",
      keys: "mod+shift+slash",
      run: () => openDialog(),
    },
    ...table(deps),
  ];
  const byId = new Map(commands.map((c) => [c.id, c]));
  let map = resolve(commands, overrides());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector(POPUPS)) {
      // History, then Inspect: it unpins, then leaves; then an expanded pane
      // returns.
      if (
        deps.history.escape() || deps.inspect.escape() ||
        deps.panes.returnFromExpand()
      ) e.preventDefault();
    }
    const c = combo(e);
    const cmd = c ? byId.get(map.byCombo.get(c) ?? "") : undefined;
    if (!cmd || (cmd.when && !cmd.when())) return;
    // A modal dialog owns the keys; only the shortcuts list still toggles.
    if (cmd.id !== "shortcuts" && document.querySelector("dialog[open]")) {
      return;
    }
    if (deps.history.open() && !IN_PREVIEW.has(cmd.id)) return;
    cmd.run();
    e.preventDefault();
  }, true);

  // A [data-command] gets "base (key)" as its title, the base kept in
  // data-title so a rerun doesn't stack (a module that retitles a button sets
  // data-title); a kbd[data-command] gets the key as its text.
  const keyLabel = (id: string) => {
    const k = map.byId[id]?.[0];
    return k ? label(k) : "";
  };
  const labelOne = (el: HTMLElement) => {
    const id = el.dataset.command ?? "";
    const k = keyLabel(id);
    if (el.tagName === "KBD") {
      el.textContent = k;
      el.hidden = !k;
      return;
    }
    const base = el.dataset.title ??= el.title;
    el.title = k ? (base ? `${base} (${k})` : k) : base;
    const keys = map.byId[id] ?? [];
    if (keys.length) {
      el.setAttribute("aria-keyshortcuts", keys.map(aria).join(" "));
    } else el.removeAttribute("aria-keyshortcuts");
  };
  const relabel = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.dataset.command) labelOne(root);
    root.querySelectorAll<HTMLElement>("[data-command]").forEach(labelOne);
  };
  relabel(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") relabel(r.target as HTMLElement);
      for (const n of r.addedNodes) {
        if (n instanceof HTMLElement) relabel(n);
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributeFilter: ["data-command", "data-title"],
  });

  const api: Shortcuts = {
    commands: () => commands,
    keymap: () => map,
    keyLabel,
    bind(id, c) {
      const o = overrides();
      if (c === null) delete o[id];
      else o[id] = c;
      store("keys", JSON.stringify(o));
      map = resolve(commands, o);
      relabel(document.body);
    },
  };
  openDialog = installShortcutsDialog(api);
  return api;
}
