import { assertEquals } from "jsr:@std/assert";
import { catalogFor, getProps, matchKey } from "./style-catalog.ts";

const catalog = catalogFor({ is: { telegram: { "font-family": "monospace" } } });

Deno.test("deepest match wins: chapter number inside a chapter", () => {
  // chain: clicked node first, then ancestors
  assertEquals(matchKey([["number"], ["chapter"], ["zone", "zone-body"], ["bml"]], catalog), "chapter.number");
});

Deno.test("a paragraph inside a chapter resolves to body, not chapter", () => {
  assertEquals(matchKey([[], ["chapter"], ["bml"]], catalog), "body");
});

Deno.test("nested matter sub-elements use the matter type", () => {
  assertEquals(matchKey([["title"], ["matter", "matter-title-page"], ["bml"]], catalog), "title-page.title");
  assertEquals(matchKey([["title"], ["matter", "matter-preface"], ["bml"]], catalog), "prose-matter.title");
});

Deno.test("page numbers resolve by zone via Paged.js margin-box classes", () => {
  const chain = [["pagedjs_margin-content"], ["pagedjs_margin", "pagedjs_margin-bottom-center"], [
    "pagedjs_page",
    "pagedjs_named_page",
    "pagedjs_front_page",
  ]];
  assertEquals(matchKey(chain, catalog), "numbering.pages.front-matter");
});

Deno.test("is: classes come from metadata", () => {
  assertEquals(matchKey([["is-telegram"], ["chapter"], ["bml"]], catalog), "is.telegram");
});

Deno.test("no match → null", () => {
  assertEquals(matchKey([["pagedjs_margin-top-right"], ["pagedjs_page"]], catalog), null);
});

Deno.test("getProps reads flat and nested paths; ignores object-valued keys", () => {
  const meta = {
    elements: { heading: { "font-size": "11pt" }, verses: { "font-size": "10pt", number: { "font-size": "7pt" } } },
  };
  const heading = catalog.find((e) => e.key === "heading")!;
  const verses = catalog.find((e) => e.key === "verses")!;
  const versesNumber = catalog.find((e) => e.key === "verses.number")!;
  assertEquals(getProps(meta, heading), { "font-size": "11pt" });
  assertEquals(getProps(meta, verses), { "font-size": "10pt" });
  assertEquals(getProps(meta, versesNumber), { "font-size": "7pt" });
  assertEquals(getProps({}, heading), {});
});
