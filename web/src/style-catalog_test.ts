import { assertEquals } from "@std/assert";
import {
  bookParts,
  catalogFor,
  getProps,
  inheritedFont,
  matchKey,
  routeFor,
  setCount,
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

Deno.test("every catalog entry belongs to exactly one part or the Page tab", () => {
  const parts = bookParts(book);
  const owners = new Map<string, number>();
  for (const p of parts) {
    for (const k of p.keys) owners.set(k, (owners.get(k) ?? 0) + 1);
  }
  for (const e of catalogFor(book)) {
    const pageTab = e.section === "numbering" || e.section === "running";
    assertEquals(owners.get(e.key) ?? 0, pageTab ? 0 : 1, e.key);
  }
  assertEquals(parts.map((p) => p.name), [
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
});

Deno.test("routeFor sends folios and running heads to the Page tab", () => {
  assertEquals(routeFor("numbering.pages.body", book), {
    tab: "page",
    focus: "folios",
  });
  assertEquals(routeFor("running.top-left", book), {
    tab: "page",
    focus: "heads",
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
    { label: "Page numbers", route: { tab: "page", focus: "folios" } },
  ]);
});

Deno.test("setCount counts set props plus opener numbering keys", () => {
  const parts = bookParts(book);
  const at = (id: string) => parts.find((p) => p.id === id)!;
  assertEquals(setCount(book, at("body")), 2);
  assertEquals(setCount(book, at("chapter")), 4); // 2 title props + style, prefix
  assertEquals(setCount(book, at("colophon")), 0);
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

Deno.test("is: classes come from metadata", () => {
  assertEquals(
    matchKey([["is-telegram"], ["chapter"], ["bml"]], catalog),
    "is.telegram",
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
  // Margin boxes sit outside the book body — they inherit nothing from it.
  assertEquals(
    inheritedFont(meta, at("numbering.pages.body")),
    "browser default",
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
