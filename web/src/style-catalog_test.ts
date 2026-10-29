import { assertEquals } from "@std/assert";
import type { Metadata } from "../../metadata/types.ts";
import {
  bookParts,
  catalogFor,
  entryName,
  folioClash,
  getProps,
  inheritedFont,
  inheritedValue,
  matchKey,
  routeFor,
  setCount,
  sourceOf,
  syncIsNames,
  usedBy,
} from "./style-catalog.ts";

const catalog = catalogFor({
  is: { telegram: { "font-family": "monospace" } },
});

Deno.test("deepest match wins: chapter number inside a chapter", () => {
  // chain: clicked node first, then ancestors
  assertEquals(
    matchKey(
      [["number"], ["chapter"], ["zone", "zone-body"], ["bml"]],
      catalog,
    ),
    "chapter.number",
  );
});

Deno.test("a paragraph inside a chapter resolves to paragraph, not chapter", () => {
  assertEquals(
    matchKey([["p"], ["chapter", "div"], ["bml", "div"]], catalog),
    "paragraph",
  );
  // Any other unclassed element still falls back to the body.
  assertEquals(matchKey([["span"], ["chapter"], ["bml"]], catalog), "body");
  assertEquals(matchKey([["em"], ["p"], ["bml"]], catalog), "em");
});

Deno.test("an {is} class wins over what it wraps", () => {
  assertEquals(
    matchKey([["p"], ["is-telegram", "div"], ["chapter"], ["bml"]], catalog),
    "is.telegram",
  );
});

const book = {
  fonts: { body: "Crimson Pro", display: "Cormorant Garamond" },
  elements: {
    body: { "font-family": "body", "font-size": "11pt" },
    chapter: { title: { "font-family": "display", "font-size": "15pt" } },
    "half-title": { title: { "font-family": "display" } },
  },
  numbering: {
    chapters: { style: "roman-upper" as const, prefix: "Chapter " },
    pages: { css: { "font-family": "display" } },
  },
  running: {
    odd: [{ content: "book-title", area: "top-right" }],
    even: [{
      content: "chapter-title",
      area: "top-left",
      "font-family": "body",
    }],
  },
  is: { telegram: { "font-family": "monospace" } },
};

Deno.test("every catalog entry belongs to exactly one part", () => {
  const parts = bookParts(book);
  const owners = new Map<string, number>();
  for (const p of parts) {
    for (const k of p.keys) owners.set(k, (owners.get(k) ?? 0) + 1);
  }
  for (const e of catalogFor(book)) {
    assertEquals(owners.get(e.key) ?? 0, 1, e.key);
  }
  assertEquals(parts.map((p) => p.name), [
    "Page numbers",
    "Running heads",
    "Half title",
    "Title page",
    "Copyright",
    "Dedication",
    "Contents",
    "Foreword, preface, introduction",
    "Body text",
    "Part opener",
    "Chapter opener",
    "Headings",
    "Epigraph",
    "Quotes, poems and asides",
    "Drop caps and breaks",
    "Illustrations",
    "Notes",
    "Appendix",
    "Colophon",
    "telegram",
  ]);
  assertEquals(parts.find((p) => p.id === "body")!.keys, [
    "body",
    "paragraph",
    "em",
  ]);
  assertEquals(parts.at(-1)!.group, "custom");
  assertEquals(parts.slice(0, 2).map((p) => [p.id, p.group]), [
    ["folios", "furniture"],
    ["heads", "furniture"],
  ]);
});

Deno.test("routeFor sends folios and running heads to their furniture parts", () => {
  assertEquals(routeFor("numbering.pages.body", book), {
    tab: "parts",
    part: "folios",
  });
  assertEquals(routeFor("numbering.pages", book), {
    tab: "parts",
    part: "folios",
  });
  assertEquals(routeFor("running.top-left", book), {
    tab: "parts",
    part: "heads",
  });
  assertEquals(routeFor("paragraph", book), {
    tab: "parts",
    part: "body",
    focus: "paragraphs",
  });
  assertEquals(routeFor("em", book), {
    tab: "parts",
    part: "body",
    focus: "emphasis",
  });
  assertEquals(routeFor("body", book), {
    tab: "parts",
    part: "body",
    focus: "paragraphs",
  });
  assertEquals(routeFor("chapter.number", book), {
    tab: "parts",
    part: "chapter",
    focus: "number",
  });
  assertEquals(routeFor("quote", book), {
    tab: "parts",
    part: "blocks",
    focus: "quote",
  });
  assertEquals(routeFor("is.telegram", book), {
    tab: "parts",
    part: "is.telegram",
  });
});

Deno.test("running heads get one catalog entry per margin area", () => {
  const e = catalogFor(book).filter((c) => c.section === "running");
  assertEquals(e.map((c) => [c.key, c.selector]), [
    ["running.top-right", ".pagedjs_margin-top-right"],
    ["running.top-left", ".pagedjs_margin-top-left"],
  ]);
  assertEquals(
    matchKey([["pagedjs_margin-top-left"], ["pagedjs_page"]], catalogFor(book)),
    "running.top-left",
  );
});

Deno.test("usedBy counts inherited body font as Body", () => {
  const body = usedBy(book, "body").map((u) => u.label);
  // Every part has text that inherits the body font; Half title's only
  // entry names display, so it is not listed.
  assertEquals(body.includes("Body text"), true);
  assertEquals(body.includes("Chapter opener"), true); // number inherits
  assertEquals(body.includes("Half title"), false);
  assertEquals(body.includes("Running heads"), true);
  assertEquals(body.includes("Page numbers"), false);
  assertEquals(usedBy(book, "display"), [
    { label: "Half title", route: { tab: "parts", part: "half-title" } },
    { label: "Chapter opener", route: { tab: "parts", part: "chapter" } },
    { label: "Page numbers", route: { tab: "parts", part: "folios" } },
  ]);
  assertEquals(
    usedBy(book, "body").find((u) => u.label === "Running heads")?.route,
    { tab: "parts", part: "heads" },
  );
});

Deno.test("setCount counts set props plus opener numbering keys", () => {
  const parts = bookParts(book);
  const at = (id: string) => parts.find((p) => p.id === id)!;
  assertEquals(setCount(book, at("body")), 2);
  assertEquals(setCount(book, at("chapter")), 4); // 2 title props + style, prefix
  assertEquals(setCount(book, at("colophon")), 0);
  assertEquals(setCount(book, at("folios")), 1); // pages.css font-family
  assertEquals(setCount(book, at("heads")), 3); // 2 contents + 1 font
  const placed = {
    numbering: {
      pages: {
        position: "top-outside" as const,
        gap: "6mm",
        body: { show: false },
      },
    },
    running: { gap: "3mm" },
  };
  assertEquals(setCount(placed, bookParts(placed)[0]!), 3);
  assertEquals(setCount(placed, bookParts(placed)[1]!), 1);
});

Deno.test("nested matter sub-elements use the matter type", () => {
  assertEquals(
    matchKey([["title"], ["matter", "matter-title-page"], ["bml"]], catalog),
    "title-page.title",
  );
  assertEquals(
    matchKey([["title"], ["matter", "matter-preface"], ["bml"]], catalog),
    "prose-matter.title",
  );
});

Deno.test("part and chapter sub-entries match their own children only", () => {
  const part = ["part", "zone-body", "section"];
  const chapter = ["chapter", "section"];
  const bml = ["bml", "article"];
  // A chapter's title inside a part is the chapter's, whatever the order.
  assertEquals(
    matchKey([["title", "h1"], chapter, part, bml], catalog),
    "chapter.title",
  );
  assertEquals(
    matchKey([["title", "h1"], chapter, part, bml], [...catalog].reverse()),
    "chapter.title",
  );
  assertEquals(matchKey([["title", "h1"], part, bml], catalog), "part.title");
  // A verse number in a chapter is a verse number.
  assertEquals(
    matchKey(
      [["number", "span"], ["verse", "p"], ["verses", "div"], chapter, bml],
      [...catalog].reverse(),
    ),
    "verses.number",
  );
  // And highlight/Inspect select the same: children, one per alternative.
  const sel = (k: string) => catalog.find((e) => e.key === k)!.selector;
  assertEquals(sel("part.title"), ".part > .title");
  assertEquals(sel("chapter.number"), ".chapter > .number");
  assertEquals(
    sel("prose-matter.title"),
    ".matter-foreword .title, .matter-preface .title, .matter-introduction .title",
  );
});

Deno.test("a classed <p> goes to its own entry, not Paragraph", () => {
  const tp = ["matter", "matter-title-page", "section"];
  for (const sub of ["author", "subtitle", "edition"]) {
    assertEquals(
      matchKey([[sub, "p"], tp, ["bml", "article"]], catalog),
      `title-page.${sub}`,
    );
  }
  // The "By" line has no class of its own: a paragraph.
  assertEquals(matchKey([["p"], tp, ["bml", "article"]], catalog), "paragraph");
});

Deno.test("page numbers resolve by zone via Paged.js margin-box classes", () => {
  const chain = [["pagedjs_margin-content"], [
    "pagedjs_margin",
    "pagedjs_margin-bottom-center",
  ], [
    "pagedjs_page",
    "pagedjs_named_page",
    "pagedjs_front_page",
  ]];
  assertEquals(matchKey(chain, catalog), "numbering.pages.front-matter");
});

Deno.test("a folio click resolves in every position", () => {
  const at = (
    position: "bottom-center" | "bottom-outside" | "top-center" | "top-outside",
  ) => catalogFor({ numbering: { pages: { position } } });
  const click = (box: string, zone = "body") => [["pagedjs_margin-content"], [
    "pagedjs_margin",
    `pagedjs_margin-${box}`,
  ], ["pagedjs_page", `pagedjs_${zone}_page`]];
  assertEquals(
    matchKey(click("bottom-center"), at("bottom-center")),
    "numbering.pages.body",
  );
  assertEquals(
    matchKey(click("top-center", "front"), at("top-center")),
    "numbering.pages.front-matter",
  );
  for (const box of ["bottom-left", "bottom-right"]) {
    assertEquals(
      matchKey(click(box), at("bottom-outside")),
      "numbering.pages.body",
      box,
    );
    assertEquals(matchKey(click(box), at("bottom-center")), null, box);
  }
  for (const box of ["top-left", "top-right"]) {
    assertEquals(
      matchKey(click(box, "back"), at("top-outside")),
      "numbering.pages.back-matter",
      box,
    );
  }
  // Without a zone class on the page, the shared entry matches.
  assertEquals(
    matchKey([["pagedjs_margin-top-right"]], at("top-outside")),
    "numbering.pages",
  );
});

Deno.test("folioClash names a running head in a top folio's box", () => {
  const running = {
    odd: [{ content: "chapter-title", area: "top-right" }],
    even: [{ content: "book-title", area: "top-center" }],
  };
  assertEquals(folioClash("top-outside", running), "top right");
  assertEquals(folioClash("top-center", running), "top center");
  assertEquals(folioClash("bottom-center", running), undefined);
  assertEquals(
    folioClash("top-outside", { even: [{ content: "x", area: "top-right" }] }),
    undefined, // top-right on a verso is the gutter side, not the folio's
  );
  assertEquals(folioClash("top-center", undefined), undefined);
  // Any margin area, not only the top ones.
  assertEquals(
    folioClash("bottom-outside", {
      even: [{ content: "x", area: "bottom-left" }],
    }),
    "bottom left",
  );
});

Deno.test("no match → null", () => {
  assertEquals(
    matchKey([["pagedjs_margin-top-right"], ["pagedjs_page"]], catalog),
    null,
  );
});

Deno.test("getProps reads flat and nested paths; ignores object-valued keys", () => {
  const meta = {
    elements: {
      heading: { "font-size": "11pt" },
      verses: { "font-size": "10pt", number: { "font-size": "7pt" } },
    },
  };
  const heading = catalog.find((e) => e.key === "heading")!;
  const verses = catalog.find((e) => e.key === "verses")!;
  const versesNumber = catalog.find((e) => e.key === "verses.number")!;
  assertEquals(getProps(meta, heading), { "font-size": "11pt" });
  assertEquals(getProps(meta, verses), { "font-size": "10pt" });
  assertEquals(getProps(meta, versesNumber), { "font-size": "7pt" });
  assertEquals(getProps({}, heading), {});
});

Deno.test("toc: a part number resolves to the nested part entry, a front-matter label to the flat one", () => {
  const toc = ["toc"];
  const matter = ["matter", "matter-toc"];
  assertEquals(
    matchKey([["number"], ["entry", "toc-part"], toc, matter, [
      "zone",
      "zone-front",
    ], ["bml"]], catalog),
    "toc.toc-part.number",
  );
  assertEquals(
    matchKey([["label"], ["entry", "toc-chapter", "in-part"], toc, matter, [
      "bml",
    ]], catalog),
    "toc.toc-chapter.label",
  );
  assertEquals(
    matchKey(
      [["label"], ["entry", "toc-front"], toc, matter, ["bml"]],
      catalog,
    ),
    "toc.label",
  );
  assertEquals(
    matchKey(
      [["leader"], ["entry", "toc-chapter"], toc, matter, ["bml"]],
      catalog,
    ),
    "toc.leader",
  );
});

Deno.test("toc: clicking a part row itself resolves to the level entry, not the generic entry row", () => {
  assertEquals(
    matchKey([[], ["entry", "toc-part"], ["toc"], ["matter", "matter-toc"], [
      "bml",
    ]], catalog),
    "toc.toc-part",
  );
});

Deno.test("toc: nested catalog entries have three-deep paths and readable labels", () => {
  const e = catalog.find((c) => c.key === "toc.toc-part.number")!;
  assertEquals(e.path, ["elements", "toc", "toc-part", "number"]);
  assertEquals(e.selector, ".matter-toc .toc-part .number");
  assertEquals(e.label, "Part number");
  assertEquals(
    catalog.find((c) => c.key === "toc.toc-back")!.label,
    "Back matter rows",
  );
});

Deno.test("a folio click resolves to its zone, not the shared page-number entry", () => {
  assertEquals(
    matchKey(
      [["pagedjs_margin-bottom-center"], ["pagedjs_margin-bottom"], [
        "pagedjs_back_page",
      ]],
      catalog,
    ),
    "numbering.pages.back-matter",
  );
});

Deno.test("inheritedFont names what an unset font actually resolves to", () => {
  const meta = {
    fonts: { body: "Crimson Pro", display: "Cormorant Garamond" },
    elements: {
      body: { "font-family": "body" },
      toc: { title: {}, "toc-part": { number: {} } },
      chapter: { "font-family": "display", title: {} },
    },
  };
  const cat = catalogFor(meta);
  const at = (key: string) => byKey(cat, key);
  // Margin boxes sit outside the book body but take its font…
  assertEquals(inheritedFont(meta, at("numbering.pages.body")), "Crimson Pro");
  // …and a zone's folio the shared folio font first.
  const shared = {
    ...meta,
    numbering: { pages: { css: { "font-family": "display" } } },
  };
  assertEquals(
    inheritedFont(shared, byKey(catalogFor(shared), "numbering.pages.body")),
    "Cormorant Garamond",
  );
  // The body itself falls back to base.css's generic serif.
  assertEquals(inheritedFont(meta, at("body")), "serif");
  // A sub-element takes the nearest ancestor entry that names a font…
  assertEquals(inheritedFont(meta, at("chapter.title")), "Cormorant Garamond");
  // …and the book body when no ancestor does, at any nesting depth.
  assertEquals(inheritedFont(meta, at("toc.title")), "Crimson Pro");
  assertEquals(inheritedFont(meta, at("toc.toc-part.number")), "Crimson Pro");
});

function byKey(catalog: ReturnType<typeof catalogFor>, key: string) {
  return catalog.find((e) => e.key === key)!;
}

Deno.test("toc: the Contents part lists outside in — title, entry, row levels, spans, per-level spans", () => {
  const keys = catalog.filter((e) => e.key.startsWith("toc.")).map((e) =>
    e.key
  );
  assertEquals(keys, [
    "toc.title",
    "toc.entry",
    "toc.toc-front",
    "toc.toc-part",
    "toc.toc-chapter",
    "toc.toc-heading",
    "toc.toc-back",
    "toc.number",
    "toc.label",
    "toc.subtitle",
    "toc.leader",
    "toc.page",
    "toc.toc-part.number",
    "toc.toc-part.label",
    "toc.toc-part.page",
    "toc.toc-chapter.number",
    "toc.toc-chapter.label",
    "toc.toc-chapter.page",
  ]);
});

Deno.test("sourceOf: set here, inherited from an ancestor or the body, or default", () => {
  const meta = {
    elements: {
      body: { "font-size": "11pt", color: "#222" },
      chapter: { "font-family": "display", "margin-top": "2em", title: {} },
      toc: { "toc-part": { "font-style": "italic", number: {} } },
      paragraph: { "text-indent": "1em" },
    },
    numbering: { pages: { css: { color: "red" } } },
  };
  const cat = catalogFor(meta);
  const at = (key: string) => byKey(cat, key);
  // Set on the entry itself.
  assertEquals(sourceOf(meta, at("paragraph"), "text-indent", cat), {
    kind: "set",
    label: "Paragraph",
  });
  // Inherited from the parent type, which has no entry of its own.
  assertEquals(sourceOf(meta, at("chapter.title"), "font-family", cat), {
    kind: "inherited",
    label: "Chapter",
  });
  // Nearest ancestor with an entry: a TOC level, named group + label.
  assertEquals(sourceOf(meta, at("toc.toc-part.number"), "font-style", cat), {
    kind: "inherited",
    label: "Contents part rows",
  });
  // Falls through to the body, then to the book default.
  assertEquals(sourceOf(meta, at("chapter.title"), "font-size", cat), {
    kind: "inherited",
    label: "Body",
  });
  assertEquals(sourceOf(meta, at("chapter.title"), "line-height", cat), {
    kind: "default",
  });
  assertEquals(sourceOf(meta, at("body"), "line-height", cat), {
    kind: "default",
  });
  // A box prop is not inherited, even though the parent sets it.
  assertEquals(sourceOf(meta, at("chapter.title"), "margin-top", cat), {
    kind: "default",
  });
  // A margin box takes only the body's fonts; a zone's folio takes the
  // shared folio style first.
  assertEquals(sourceOf(meta, at("numbering.pages.body"), "color", cat), {
    kind: "inherited",
    label: "All page numbers",
  });
  assertEquals(sourceOf(meta, at("numbering.pages.body"), "font-size", cat), {
    kind: "inherited",
    label: "Body",
  });
  assertEquals(sourceOf(meta, at("numbering.pages"), "line-height", cat), {
    kind: "default",
  });
  assertEquals(sourceOf(meta, at("numbering.pages"), "color", cat), {
    kind: "set",
    label: "All page numbers",
  });
});

Deno.test("entryName: the source label, margin boxes by what they hold", () => {
  const meta = {
    running: { odd: [{ content: "book-title", area: "top-center" }] },
  };
  const cat = catalogFor(meta);
  const name = (key: string) => entryName(byKey(cat, key), cat);
  assertEquals(name("chapter.title"), "Chapter title");
  assertEquals(name("paragraph"), "Paragraph");
  assertEquals(name("numbering.pages.body"), "Page number");
  assertEquals(name("running.top-center"), "Running head");
  const head = {
    running: { odd: [{ content: "", area: "top-center", "font-size": "8pt" }] },
  };
  assertEquals(
    sourceOf(head, byKey(cat, "running.top-center"), "font-size", cat),
    { kind: "set", label: "Running heads" },
  );
});

Deno.test("syncIsNames: adds the manuscript's names, drops unstyled stale ones", () => {
  const meta: Metadata = { is: { fo: {}, old: { color: "red" } } };
  syncIsNames(meta, ["foo"]);
  assertEquals(meta.is, { old: { color: "red" }, foo: {} });
  const none: Metadata = {};
  syncIsNames(none, []);
  assertEquals(none, {}); // no `is` section conjured
});

Deno.test("book colors: what a part inherits, and who uses each (§4.15)", () => {
  const meta = {
    colors: { ink: "#111111", rubric: "#9e2a1e" },
    elements: {
      body: { color: "ink" },
      chapter: { number: { color: "rubric" } },
    },
    running: { odd: [{ content: "book-title", area: "top-right" }] },
  };
  const cat = catalogFor(meta);
  const ink = (k: string) => inheritedValue(meta, byKey(cat, k), "color");
  assertEquals(ink("chapter.title"), "ink");
  assertEquals(ink("running.top-right"), "ink"); // heads take the body's ink
  assertEquals(ink("body"), undefined);
  assertEquals(
    usedBy(meta, "rubric", "color").map((u) => u.label),
    ["Chapter opener"],
  );
  const users = usedBy(meta, "ink", "color").map((u) => u.label);
  assertEquals(users.includes("Body text"), true);
  assertEquals(users.includes("Running heads"), true);
  // Fonts are unchanged by the color form.
  assertEquals(usedBy(meta, "rubric").length, 0);
});
