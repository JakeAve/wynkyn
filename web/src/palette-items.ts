// web/src/palette-items.ts — the palette's rows from the app's sources (spec
// §7, the command palette): commands, sentinels, the outline, styles.
import type { Item } from "./palette.ts";
import type { Shortcuts } from "./shortcuts.ts";
import { type Snippet, SNIPPETS } from "./snippets.ts";
import type { TreeNode } from "./tree-data.ts";
import {
  type BookPart,
  bookParts,
  catalogFor,
  entryName,
} from "./style-catalog.ts";
import type { Metadata } from "../../metadata/types.ts";

export interface ItemSources {
  shortcuts: Shortcuts;
  nodes: TreeNode[];
  metadata: Metadata;
  /** False while a History version is open: only commands may run. */
  editable: boolean;
  insert(s: Snippet): void;
  goToLine(line: number): void;
  openPart(id: string): void;
  pickStyle(key: string): void;
}

const PART_GROUP: Record<BookPart["group"], string> = {
  furniture: "Page furniture",
  front: "Front matter",
  body: "Body",
  back: "Back matter",
  custom: "Custom styles",
};

export function paletteItems(src: ItemSources): Item[] {
  const sc = src.shortcuts;
  const off = !src.editable;
  const commands = sc.commands().filter((c) => c.id !== "palette").map((
    c,
  ): Item => ({
    id: c.id,
    label: c.label,
    group: "Commands",
    detail: c.section,
    keys: sc.keyLabel(c.id) || undefined,
    off: sc.can(c.id) === "off",
    run: () => sc.run(c.id),
  }));
  const sentinels = SNIPPETS.map((s): Item => ({
    id: `{${s.label}`,
    label: s.label,
    group: "Sentinels",
    detail: s.description,
    off,
    run: () => src.insert(s),
  }));
  const places = src.nodes.flatMap((n) => [n, ...n.children]).map((
    n,
  ): Item => ({
    id: `go:${n.anchorId}`,
    label: n.label,
    group: "Go to",
    detail: n.kind,
    off,
    run: () => src.goToLine(n.line),
  }));
  const parts = bookParts(src.metadata).map((p): Item => ({
    id: `part:${p.id}`,
    label: p.name,
    group: "Styles",
    detail: PART_GROUP[p.group],
    off,
    run: () => src.openPart(p.id),
  }));
  // A part and its one entry share a name (Copyright), and each page number
  // and running head slot is "Page number" / "Running head": one row each.
  const seen = new Set(parts.map((p) => p.label.toLowerCase()));
  const catalog = catalogFor(src.metadata);
  const entries = catalog.flatMap((e): Item[] => {
    const label = entryName(e, catalog);
    if (seen.has(label.toLowerCase())) return [];
    seen.add(label.toLowerCase());
    return [{
      id: `style:${e.key}`,
      label,
      group: "Styles",
      detail: e.group,
      off,
      run: () => src.pickStyle(e.key),
    }];
  });
  return [...commands, ...sentinels, ...places, ...parts, ...entries];
}
