// Regression guard: buildTree() (tree-data.ts) hand-derives anchor ids using a
// convention documented to match renderer/render.ts's id-generation exactly
// (see the "must match renderMatter()" comment in tree-data.ts). Nothing else
// checks that the two actually agree — a change to render.ts's id format
// could silently break click-to-scroll without any other test noticing.
// This test renders the same doc both ways and asserts every anchorId
// buildTree() produces is a real id in the rendered HTML.
import { assertStringIncludes } from "@std/assert";
import { parse } from "../../parser/parser.ts";
import { render } from "../../renderer/render.ts";
import { buildTree, type TreeNode } from "./tree-data.ts";

const SOURCE = `{matter: title-page}
{title}
My Book

{part: one}
{title}
Part One

{chapter: thaw}
{title}
The {em}First{/em} Thaw

{chapter: crossing}

{matter: appendix | label: A}
{title}
Family Tree
`;

function assertAllAnchorsPresent(nodes: TreeNode[], html: string): void {
  for (const node of nodes) {
    assertStringIncludes(html, `id="${node.anchorId}"`);
    assertAllAnchorsPresent(node.children, html);
  }
}

Deno.test("every buildTree anchorId appears as a real id in render() output", () => {
  const doc = parse(SOURCE);
  const html = render(doc, {});
  const tree = buildTree(doc);
  assertAllAnchorsPresent(tree, html);
});
