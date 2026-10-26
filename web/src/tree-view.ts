// web/src/tree-view.ts — render the project tree; clicks report the node.
// Navigation-only in v1 (spec §7.2, §8): no drag, no reorder.
import type { TreeNode } from "./tree-data.ts";

const GROUPS: Array<[TreeNode["group"], string]> = [
  ["front", "Front matter"],
  ["body", "Chapters"],
  ["back", "Back matter"],
];

// One heading per non-empty group, its nodes listed under it.
export function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  onSelect: (node: TreeNode) => void,
): void {
  container.replaceChildren(...GROUPS.flatMap(([group, title]) => {
    const items = nodes.filter((n) => n.group === group);
    if (!items.length) return [];
    const h = document.createElement("div");
    h.className = "nh";
    h.textContent = title;
    return [h, list(items, 0, onSelect)];
  }));
}

function list(
  items: TreeNode[],
  depth: number,
  onSelect: (node: TreeNode) => void,
): HTMLElement {
  const ul = document.createElement("ul");
  ul.className = "tree-list";
  for (const n of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = `tree-node tree-${n.kind}`;
    btn.style.paddingLeft = `calc(var(--s-4) + ${depth * 0.875}rem)`;
    btn.textContent = n.label;
    btn.dataset.line = String(n.line);
    btn.onclick = () => {
      btn.closest("nav")?.querySelector("[aria-current]")?.removeAttribute(
        "aria-current",
      );
      btn.setAttribute("aria-current", "true");
      onSelect(n);
    };
    li.appendChild(btn);
    if (n.children.length) {
      li.appendChild(list(n.children, depth + 1, onSelect));
    }
    ul.appendChild(li);
  }
  return ul;
}
