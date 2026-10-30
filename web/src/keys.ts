// web/src/keys.ts — the key model for shortcuts (spec: shortcuts): key events
// to combos, platform labels, and defaults + overrides resolved into a keymap.
// Pure; ported from forest's keys.js. Combos are lowercase, `+`-joined,
// modifiers in the order ctrl, alt, shift, cmd, then the key name.

import type { Mode } from "./preview.ts";

export const isMac: boolean = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform ?? "");

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface Command {
  id: string;
  label: string;
  section: string;
  /** The mode it lives in: from another, it runs after a switch. */
  mode?: Mode;
  keys: string;
  /** The Style panel nav row it opens. */
  nav?: string;
  win?: string;
  mac?: string;
  when?(): boolean;
  run(): void;
}

export interface Keymap {
  byId: Record<string, string[]>;
  byCombo: Map<string, string>;
}

const MODS = ["ctrl", "alt", "shift", "cmd"];
const ALIAS: Record<string, string> = {
  meta: "cmd",
  command: "cmd",
  option: "alt",
  control: "ctrl",
};

// Letters follow the layout (Dvorak, AZERTY); everything else is the physical
// key, which also keeps ⌥ from turning N into a dead key and a Russian "у"
// into something other than E. The keypad's digits and Enter are the main ones.
// ponytail: on a German layout mod+backslash is the physical US `\` key,
// labelled `#` there. Fix by reading the layout map if anyone binds it.
export function combo(e: KeyLike): string | null {
  const key = /^[a-zA-Z]$/.test(e.key)
    ? e.key.toLowerCase()
    : e.code.replace(/^(Key|Digit|Numpad(?=\d$|Enter$))/, "").toLowerCase();
  if (!key || /^(meta|os|alt|shift|control)(left|right)?$/.test(key)) {
    return null;
  }
  const on = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey];
  return [...MODS.filter((_, i) => on[i]), key].join("+");
}

export function norm(s: string, mac = isMac): string {
  const parts = s.toLowerCase().split("+").map((p) => {
    p = p.trim();
    return p === "mod" ? (mac ? "cmd" : "ctrl") : ALIAS[p] ?? p;
  });
  const key = parts.pop() ?? "";
  return [...MODS.filter((m) => parts.includes(m)), key].join("+");
}

const MAC_MOD: Record<string, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
};
const WIN_MOD: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  cmd: "Win",
};
const SYMBOL: Record<string, string> = {
  minus: "-",
  numpadadd: "+",
  numpadsubtract: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};
const MAC_KEY: Record<string, string> = {
  enter: "↩",
  escape: "⎋",
  backspace: "⌫",
  tab: "⇥",
  space: "Space",
};
const WIN_KEY: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  tab: "Tab",
  space: "Space",
};
const SHIFTED: Record<string, string> = {
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  minus: "_",
  equal: "+",
  bracketleft: "{",
  bracketright: "}",
  backslash: "|",
  semicolon: ":",
  quote: '"',
  comma: "<",
  period: ">",
  slash: "?",
  backquote: "~",
};

// Takes a combo or a default as written ("mod+a").
export function label(c: string, mac = isMac): string {
  const parts = norm(c, mac).split("+");
  let key = parts.pop() ?? "";
  // Mac menus fold Shift into the symbol (⌘?); Windows spells it out
  // (Ctrl+Shift+1), and a US-only symbol would mislead other layouts there.
  const shifted = mac ? SHIFTED[key] : undefined;
  if (shifted && parts.includes("shift")) {
    parts.splice(parts.indexOf("shift"), 1);
    key = shifted;
  } else {
    key = SYMBOL[key] ?? (mac ? MAC_KEY : WIN_KEY)[key] ??
      key.replace(/^./, (ch) => ch.toUpperCase());
  }
  const mods = parts.map((p) => (mac ? MAC_MOD : WIN_MOD)[p] ?? p);
  return mac ? [...mods, key].join("") : [...mods, key].join("+");
}

export function resolve(
  commands: Pick<Command, "id" | "keys" | "win" | "mac">[],
  overrides: Record<string, string>,
  mac = isMac,
): Keymap {
  const own = (id: string) => Object.hasOwn(overrides, id);
  const keysOf = (c: Pick<Command, "id" | "keys" | "win" | "mac">) =>
    (own(c.id) ? overrides[c.id] : (mac ? c.mac : c.win) ?? c.keys) ?? "";
  const byId: Record<string, string[]> = {};
  for (const c of commands) {
    byId[c.id] = keysOf(c).split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => norm(s, mac));
  }
  const byCombo = new Map<string, string>();
  // Rebound commands go last so they win a contested combo.
  for (const c of [...commands].sort((a, b) => +own(a.id) - +own(b.id))) {
    for (const k of byId[c.id] ?? []) byCombo.set(k, c.id);
  }
  for (const id in byId) {
    byId[id] = (byId[id] ?? []).filter((k) => byCombo.get(k) === id);
  }
  return { byId, byCombo };
}

const WIN_RESERVED = new Map([
  ["ctrl+n", "opens a new browser window"],
  ["ctrl+t", "opens a new browser tab"],
  ["ctrl+w", "closes the browser tab"],
  ["ctrl+shift+n", "opens a private browser window"],
  ["ctrl+shift+t", "reopens a closed browser tab"],
  ["ctrl+shift+w", "closes the browser window"],
  ["ctrl+tab", "switches browser tabs"],
  ["alt+f4", "closes the window"],
]);
const MAC_RESERVED = new Map([
  ["cmd+q", "quits the browser"],
  ["cmd+w", "closes the browser tab"],
  ["cmd+t", "opens a new browser tab"],
  ["cmd+n", "opens a new browser window"],
  ["shift+cmd+q", "logs out of macOS"],
  ["cmd+tab", "switches apps"],
  ["cmd+space", "opens Spotlight"],
]);

// The browser or OS takes these before the page sees them.
export function reserved(c: string, mac = isMac): string | null {
  const why = (mac ? MAC_RESERVED : WIN_RESERVED).get(c);
  return why ? `${label(c, mac)} ${why}; the page can't use it.` : null;
}

// ⌥ plus a printable key types a character on a Mac (⌥E, ⌥N, ⌥] for ’), so it
// clashes with text.
export function caution(c: string, mac = isMac): string | null {
  const key = (mac && /^alt(?:\+shift)?\+(.+)$/.exec(c)?.[1]) || "";
  return /^[a-z]$/.test(key) || key in SHIFTED || key === "space"
    ? `${
      label(c, mac)
    } types a character in the editor on a Mac (⌥E, ⌥N for Spanish, ⌥] for ’).`
    : null;
}
