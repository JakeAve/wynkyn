// web/src/tree-data.ts — BmlDocument → project-tree rows (spec §7.2). Pure:
// walks the parsed tree (§5.1 — never re-parses BML) and mirrors the anchor
// id formats emitted by renderer/render.ts, which must match exactly.
import type {
  BmlDocument,
  Chapter,
  ContentNode,
  Inline,
  MatterBlock,
  Part,
} from "../../parser/types.ts";

export interface TreeNode {
  label: string;
  line: number; // 1-based manuscript line — editor scroll target
  anchorId: string; // rendered element id — preview scroll target
  kind: "matter" | "part" | "chapter";
  group: "front" | "body" | "back"; // the Write nav's heading
  children: TreeNode[];
}

export function buildTree(doc: BmlDocument): TreeNode[] {
  return [
    ...doc.frontMatter.map((m) => matterNode(m, "front")),
    ...doc.body.map((b) => (b.kind === "part" ? partNode(b) : chapterNode(b))),
    ...doc.backMatter.map((m) => matterNode(m, "back")),
  ];
}

// "half-title" → "Half title"; `toc` reads as what it is.
function humanize(type: string): string {
  const t = type === "toc" ? "contents" : type.replaceAll("-", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function inlineText(inlines: Inline[]): string {
  return inlines
    .map((i) =>
      i.kind === "text"
        ? i.text
        : i.kind === "em"
        ? inlineText(i.children)
        : i.kind === "linebreak"
        ? " "
        : ""
    )
    .join("");
}

function titleOf(children: (ContentNode | Chapter)[]): string | null {
  for (const c of children) {
    if (c.kind === "component" && c.name === "title") {
      return inlineText(c.inlines);
    }
  }
  return null;
}

// Their {title} is the book's, so it would name them all alike.
const BOOK_TITLED = new Set(["half-title", "title-page"]);

function matterNode(m: MatterBlock, group: "front" | "back"): TreeNode {
  const type = m.label ? `${humanize(m.type)} ${m.label}` : humanize(m.type);
  return {
    label: (!BOOK_TITLED.has(m.type) && titleOf(m.children)) || type,
    line: m.line,
    // must match renderMatter() in renderer/render.ts
    anchorId: `matter-${m.type}${m.label ? `-${m.label.toLowerCase()}` : ""}`,
    kind: "matter",
    group,
    children: [],
  };
}

function chapterNode(ch: Chapter): TreeNode {
  return {
    label: titleOf(ch.children) ?? ch.slug,
    line: ch.line,
    anchorId: ch.slug,
    kind: "chapter",
    group: "body",
    children: [],
  };
}

function partNode(p: Part): TreeNode {
  return {
    label: titleOf(p.children) ?? p.slug,
    line: p.line,
    anchorId: p.slug,
    kind: "part",
    group: "body",
    children: p.children
      .filter((c): c is Chapter => c.kind === "chapter")
      .map(chapterNode),
  };
}
