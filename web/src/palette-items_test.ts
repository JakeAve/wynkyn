import { assert, assertEquals } from "@std/assert";
import { paletteItems } from "./palette-items.ts";
import type { Shortcuts } from "./shortcuts.ts";
import type { Command } from "./keys.ts";
import { bookParts, catalogFor, entryName } from "./style-catalog.ts";
import type { Metadata } from "../../metadata/types.ts";

const command = (id: string, section: string, nav?: string): Command => ({
  id,
  label: id,
  section,
  keys: "",
  nav,
  run() {},
});

const commands = [
  command("em", "Writing"),
  command("prose-source", "Writing"),
  command("style-body", "Style", "body"),
];

const shortcuts = {
  commands: () => commands,
  keyLabel: (id: string) => id === "em" ? "⌘I" : "",
  can: () => "now",
  run() {},
} as unknown as Shortcuts;

const metadata: Metadata = {
  running: {
    odd: [{ area: "top-right" }],
    even: [{ area: "top-left" }],
  },
} as Metadata;

const items = paletteItems({
  shortcuts,
  nodes: [],
  metadata,
  editable: true,
  insert() {},
  goToLine() {},
  openPart() {},
  pickStyle() {},
});

Deno.test("palette rows: one per destination, each told apart", () => {
  const ids = new Set(items.map((i) => i.id));
  const parts = new Set(bookParts(metadata).map((p) => p.name));
  const catalog = catalogFor(metadata);
  for (const e of catalog) {
    if (ids.has(`style:${e.key}`)) continue;
    assert(parts.has(entryName(e, catalog)), `${e.key} unreachable`);
  }
  const seen = items.map((i) => `${i.group}|${i.label}|${i.detail}`);
  assertEquals(seen.length, new Set(seen).size);
  assert(!ids.has("em"), "a snippet command doubles its sentinel");
  assertEquals(items.find((i) => i.id === "{em")?.keys, "⌘I");
  assert(ids.has("prose-source"));
  assert(!ids.has("part:body"), "Body opens from its command too");
});
