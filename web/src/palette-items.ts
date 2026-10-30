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
  const snippet = new Set(SNIPPETS.map((s) => s.label));
  // A snippet command is its sentinel's row; it lends that row its key.
  const all = sc.commands().filter((c) => c.id !== "palette");
  const commands = all.filter((c) => !snippet.has(c.id)).map((c): Item => ({
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
    keys: sc.keyLabel(s.label) || undefined,
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
  const navs = new Set(all.flatMap((c) => c.nav ?? []));
  const parts = bookParts(src.metadata).filter((p) => !navs.has(p.id)).map((
    p,
  ): Item => ({
    id: `part:${p.id}`,
    label: p.name,
    group: "Styles",
    detail: PART_GROUP[p.group],
    off,
    run: () => src.openPart(p.id),
  }));
  // An entry named as a part (Copyright) opens that part: the part's row is it.
  const named = new Set(
    bookParts(src.metadata).map((p) => p.name.toLowerCase()),
  );
  const catalog = catalogFor(src.metadata);
  const labels = catalog.map((e) => entryName(e, catalog));
  const count = (l: string) => labels.filter((x) => x === l).length;
  const entries = catalog.flatMap((e, i): Item[] => {
    const label = labels[i]!;
    if (named.has(label.toLowerCase())) return [];
    return [{
      id: `style:${e.key}`,
      label,
      group: "Styles",
      // Every page number slot is "Page number": its own label tells them apart.
      detail: count(label) > 1 ? `${e.group}: ${e.label}` : e.group,
      off,
      run: () => src.pickStyle(e.key),
    }];
  });
  return [...commands, ...sentinels, ...places, ...parts, ...entries];
}
