// web/src/shortcuts.ts — every app shortcut (spec §7, shortcuts): one command
// table, one capture-phase keydown, and the label pass that writes each key
// into the chrome from `data-command`. Overrides are per browser, localStorage
// `keys`: JSON { id: "ctrl+b" }, where "" unbinds.
import type { EditorView } from "@codemirror/view";
import { combo, type Command, type Keymap, label, resolve } from "./keys.ts";
import { insertSnippet, openPalette } from "./editor-insert.ts";
import { SNIPPETS } from "./snippets.ts";
import type { Mode } from "./preview.ts";
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
  setMode(mode: Mode): void;
  panes: Panes;
  textView: TextView;
  inspect: { escape(): boolean };
  editor(): EditorView;
}

// Open popups esc closes first: a dialog, the find bar, completions, the
// sentinel palette and wrap bar, menus (the zoom menu is a popover). Not
// hover tooltips (spelling, lint).
const POPUPS =
  "dialog[open], [popover]:popover-open, .cm-tooltip-autocomplete, .cm-bml-find, .cm-bml-palette, .cm-bml-wrapbar:not(.cm-bml-spell), .fontpop, .tvpop:not([hidden])";

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
    when: write,
    run: () => insertSnippet(d.editor(), SNIPPETS.find((s) => s.label === id)!),
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
      when: write,
      run: () => openPalette(d.editor()),
    },
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
      // Inspect first: it unpins, then leaves; then an expanded pane returns.
      if (deps.inspect.escape() || deps.panes.returnFromExpand()) {
        e.preventDefault();
      }
    }
    const c = combo(e);
    const cmd = c ? byId.get(map.byCombo.get(c) ?? "") : undefined;
    if (!cmd || (cmd.when && !cmd.when())) return;
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
