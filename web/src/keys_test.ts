import { assertEquals } from "@std/assert";
import {
  caution,
  combo,
  type KeyLike,
  label,
  norm,
  reserved,
  resolve,
} from "./keys.ts";

const ev = (
  key: string,
  code: string,
  mods: Partial<KeyLike> = {},
): KeyLike => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

Deno.test("combo follows the layout for letters", () => {
  assertEquals(combo(ev("e", "KeyD", { ctrlKey: true })), "ctrl+e"); // Dvorak
  assertEquals(combo(ev("у", "KeyE", { ctrlKey: true })), "ctrl+e"); // Russian
  assertEquals(
    combo(ev("F", "KeyF", { ctrlKey: true, shiftKey: true })),
    "ctrl+shift+f",
  );
});

Deno.test("combo uses the physical key for digits, punctuation and dead keys", () => {
  assertEquals(combo(ev("&", "Digit1", { ctrlKey: true })), "ctrl+1"); // AZERTY
  assertEquals(
    combo(ev("Dead", "KeyN", { altKey: true, metaKey: true })),
    "alt+cmd+n",
  );
  assertEquals(
    combo(ev("˜", "KeyN", { altKey: true, metaKey: true })),
    "alt+cmd+n",
  );
  assertEquals(combo(ev("Enter", "Enter", { metaKey: true })), "cmd+enter");
  assertEquals(
    combo(ev("]", "BracketRight", { altKey: true })),
    "alt+bracketright",
  );
});

Deno.test("combo ignores a lone modifier", () => {
  assertEquals(combo(ev("Control", "ControlLeft", { ctrlKey: true })), null);
  assertEquals(combo(ev("Shift", "ShiftRight", { shiftKey: true })), null);
  assertEquals(combo(ev("Meta", "MetaLeft", { metaKey: true })), null);
  assertEquals(combo(ev("Alt", "AltLeft", { altKey: true })), null);
});

Deno.test("norm expands mod and aliases and orders modifiers", () => {
  assertEquals(norm("mod+shift+F", false), "ctrl+shift+f");
  assertEquals(norm("mod+shift+F", true), "shift+cmd+f");
  assertEquals(norm("Command+Option+N"), "alt+cmd+n");
  assertEquals(norm("shift+control+x"), "ctrl+shift+x");
});

Deno.test("label is native to each platform", () => {
  assertEquals(label("ctrl+shift+f", false), "Ctrl+Shift+F");
  assertEquals(label("ctrl+enter", false), "Ctrl+Enter");
  assertEquals(label("alt+bracketright", false), "Alt+]");
  assertEquals(label("ctrl+shift+slash", false), "Ctrl+?");
  assertEquals(label("ctrl+1", false), "Ctrl+1");
  assertEquals(label("shift+cmd+f", true), "⇧⌘F");
  assertEquals(label("ctrl+alt+shift+cmd+f", true), "⌃⌥⇧⌘F");
  assertEquals(label("cmd+enter", true), "⌘↩");
  assertEquals(label("cmd+shift+slash", true), "⌘?");
  assertEquals(label("alt+bracketright", true), "⌥]");
});

const cmds = [
  { id: "a", keys: "mod+1" },
  { id: "b", keys: "mod+2, mod+comma" },
  { id: "c", keys: "mod+k", win: "ctrl+alt+k", mac: "alt+cmd+k" },
];

Deno.test("resolve gives each command its defaults", () => {
  const { byId, byCombo } = resolve(cmds, {}, false);
  assertEquals(byId.a, ["ctrl+1"]);
  assertEquals(byId.b, ["ctrl+2", "ctrl+comma"]);
  assertEquals(byCombo.get("ctrl+comma"), "b");
});

Deno.test("resolve applies win and mac keys per platform", () => {
  assertEquals(resolve(cmds, {}, false).byId.c, ["ctrl+alt+k"]);
  assertEquals(resolve(cmds, {}, true).byId.c, ["alt+cmd+k"]);
  assertEquals(resolve(cmds, {}, true).byId.a, ["cmd+1"]);
});

Deno.test("an override replaces defaults and an empty one unbinds", () => {
  const { byId, byCombo } = resolve(cmds, { a: "mod+shift+x", b: "" }, false);
  assertEquals(byId.a, ["ctrl+shift+x"]);
  assertEquals(byId.b, []);
  assertEquals(byCombo.has("ctrl+2"), false);
  assertEquals(byCombo.has("ctrl+1"), false);
});

Deno.test("a rebound command wins a contested combo; the default loser drops it", () => {
  const { byId, byCombo } = resolve(cmds, { c: "mod+2" }, false);
  assertEquals(byCombo.get("ctrl+2"), "c");
  assertEquals(byId.c, ["ctrl+2"]);
  assertEquals(byId.b, ["ctrl+comma"]);
});

Deno.test("reserved names the browser and OS combos", () => {
  for (
    const c of [
      "ctrl+n",
      "ctrl+t",
      "ctrl+w",
      "ctrl+shift+n",
      "ctrl+shift+t",
      "ctrl+shift+w",
      "ctrl+tab",
      "alt+f4",
    ]
  ) {
    assertEquals(typeof reserved(c, false), "string", c);
  }
  for (
    const c of [
      "cmd+q",
      "cmd+w",
      "cmd+t",
      "cmd+n",
      "shift+cmd+q",
      "cmd+tab",
      "cmd+space",
    ]
  ) {
    assertEquals(typeof reserved(c, true), "string", c);
  }
  assertEquals(reserved("ctrl+n", true), null);
  assertEquals(reserved("cmd+q", false), null);
  assertEquals(reserved("ctrl+shift+f", false), null);
});

Deno.test("caution flags option plus a letter on a Mac only", () => {
  assertEquals(typeof caution("alt+e", true), "string");
  assertEquals(typeof caution("alt+shift+n", true), "string");
  assertEquals(caution("alt+cmd+n", true), null);
  assertEquals(caution("alt+bracketright", true), null);
  assertEquals(caution("alt+e", false), null);
});
