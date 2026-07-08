// web/src/tree-view.ts — render the project tree; clicks report the node.
// Navigation-only in v1 (spec §7.2, §8): no drag, no reorder.
import type { TreeNode } from "./tree-data.ts";

export function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  onSelect: (node: TreeNode) => void,
): void {
  container.innerHTML = "";
  container.appendChild(list(nodes, 0, onSelect));
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
    btn.style.paddingLeft = `${8 + depth * 14}px`;
    btn.textContent = n.label;
    btn.onclick = () => onSelect(n);
    li.appendChild(btn);
    if (n.children.length) li.appendChild(list(n.children, depth + 1, onSelect));
    ul.appendChild(li);
  }
  return ul;
}
