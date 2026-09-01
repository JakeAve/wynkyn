import { assertEquals } from "@std/assert";
import { parse } from "../../parser/parser.ts";
import { buildTree } from "./tree-data.ts";

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

Deno.test("tree mirrors front matter, part-nested chapters, back matter", () => {
  const tree = buildTree(parse(SOURCE));
  assertEquals(tree.map((n) => [n.kind, n.label, n.anchorId, n.line]), [
    ["matter", "title-page", "matter-title-page", 1],
    ["part", "Part One", "one", 5],
    ["matter", "appendix A", "matter-appendix-a", 15],
  ]);
  const part = tree[1]!;
  assertEquals(part.children.map((n) => [n.label, n.anchorId, n.line]), [
    ["The First Thaw", "thaw", 9], // em flattens into the label
    ["crossing", "crossing", 13], // untitled chapter falls back to its slug
  ]);
});

Deno.test("top-level chapters appear without a part wrapper", () => {
  const tree = buildTree(parse("{chapter: solo}\n{title}\nAlone\n"));
  assertEquals(tree.map((n) => [n.kind, n.label, n.anchorId]), [
    ["chapter", "Alone", "solo"],
  ]);
});
