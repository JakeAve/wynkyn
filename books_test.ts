// books_test.ts — the two public-domain fixture books under testdata/ are the
// full-grammar regression corpus; they are tracked so a fresh clone and CI run them.
import { assert, assertEquals } from "@std/assert";
import { parse } from "./parser/parser.ts";
import { loadMetadata } from "./metadata/loader.ts";
import { render } from "./renderer/render.ts";
import type { BmlDocument, ContentNode, Inline } from "./parser/types.ts";

const BOOKS = ["common-sense", "great-gatsby"];
const DIR = new URL("./testdata/", import.meta.url).pathname;

function collectKinds(doc: BmlDocument): Set<string> {
  const kinds = new Set<string>();
  const walkInlines = (inlines: Inline[]) => {
    for (const i of inlines) {
      kinds.add(`inline:${i.kind}`);
      if (i.kind === "em") walkInlines(i.children);
    }
  };
  const walk = (nodes: ContentNode[]) => {
    for (const n of nodes) {
      kinds.add(n.kind);
      if ("inlines" in n) walkInlines(n.inlines);
      if ("caption" in n && n.caption) walkInlines(n.caption);
      if ("items" in n) n.items.forEach(walkInlines);
      if ("attribution" in n && n.attribution) kinds.add("attribution");
      if ("children" in n && Array.isArray(n.children)) {
        walk(n.children as ContentNode[]);
      }
      if (n.kind === "poem") walk(n.stanzas);
      if (n.kind === "verses") walk(n.verses);
      if (n.kind === "columns") n.columns.forEach(walk);
    }
  };
  for (const m of [...doc.frontMatter, ...doc.backMatter]) {
    kinds.add("matter");
    walk(m.children);
  }
  for (const b of doc.body) {
    kinds.add(b.kind);
    walk(b.children as ContentNode[]);
  }
  return kinds;
}

Deno.test("both books parse clean, load metadata, and render", async () => {
  for (const book of BOOKS) {
    const src = await Deno.readTextFile(`${DIR}${book}/manuscript.md`);
    const doc = parse(src);
    assertEquals(doc.diagnostics, [], `${book}: parse diagnostics`);
    assert(doc.frontMatter.length > 0, `${book}: no front matter`);
    assert(doc.backMatter.length > 0, `${book}: no back matter`);
    const meta = await loadMetadata(`${DIR}${book}/metadata.json`);
    assert(meta !== null, `${book}: missing metadata.json`);
    const html = render(doc, {
      numbering: meta!.numbering,
      notes: meta!.notes,
    });
    assert(html.includes('class="chapter"'), `${book}: rendered no chapters`);
  }
});

Deno.test("the two books together exercise the full grammar (spec §9 Plan 0)", async () => {
  const all = new Set<string>();
  for (const book of BOOKS) {
    const doc = parse(await Deno.readTextFile(`${DIR}${book}/manuscript.md`));
    for (const k of collectKinds(doc)) all.add(k);
  }
  const required = [
    "matter",
    "part",
    "chapter",
    "paragraph",
    "component",
    "dropcap",
    "heading",
    "break",
    "epigraph",
    "quote",
    "poem",
    "pullquote",
    "sidebar",
    "verses",
    "columns",
    "is",
    "illustration",
    "list",
    "note",
    "attribution",
    "inline:text",
    "inline:em",
    "inline:footnote",
    "inline:ref",
    "inline:linebreak",
  ];
  for (const k of required) {
    assert(all.has(k), `no book exercises: ${k}`);
  }
});
