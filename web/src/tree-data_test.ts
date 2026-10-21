import { assertEquals } from "@std/assert";
import { parse } from "../../parser/parser.ts";
import { buildTree } from "./tree-data.ts";

const SOURCE = `{matter: title-page}
{title}
My Book

{matter: preface}
{title}
Before

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
  assertEquals(
    tree.map((n) => [n.kind, n.group, n.label, n.anchorId, n.line]),
    [
      // the book's title would name every display page alike: its type
      ["matter", "front", "Title page", "matter-title-page", 1],
      ["matter", "front", "Before", "matter-preface", 5],
      ["part", "body", "Part One", "one", 9],
      ["matter", "back", "Family Tree", "matter-appendix-a", 19],
    ],
  );
  const part = tree[2]!;
  assertEquals(
    part.children.map((n) => [n.group, n.label, n.anchorId, n.line]),
    [
      ["body", "The First Thaw", "thaw", 13], // em flattens into the label
      ["body", "crossing", "crossing", 17], // untitled chapter: its slug
    ],
  );
});

Deno.test("untitled matter falls back to its humanized type: labelled appendix, contents", () => {
  const tree = buildTree(
    parse("{matter: toc}\n\n{matter: appendix | label: B}\n"),
  );
  assertEquals(tree.map((n) => n.label), ["Contents", "Appendix B"]);
});

Deno.test("top-level chapters appear without a part wrapper", () => {
  const tree = buildTree(parse("{chapter: solo}\n{title}\nAlone\n"));
  assertEquals(tree.map((n) => [n.kind, n.label, n.anchorId]), [
    ["chapter", "Alone", "solo"],
  ]);
});
