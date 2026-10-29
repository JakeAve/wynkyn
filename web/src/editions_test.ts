import { assertEquals } from "@std/assert";
import {
  appHref,
  editionHref,
  firstSpanLine,
  freeSlug,
  lineFromHash,
  prettySize,
  slugify,
} from "./editions.ts";

Deno.test("freeSlug: the theme's slug, then -2, -3…, never default", () => {
  assertEquals(freeSlug("caslon", []), "caslon");
  assertEquals(freeSlug("caslon", ["caslon"]), "caslon-2");
  assertEquals(freeSlug("Caslon", ["caslon", "caslon-2"]), "caslon-3");
  assertEquals(freeSlug("default", []), "default-2");
});

Deno.test("slugify: lowercase, hyphens, no leading/trailing/double hyphens", () => {
  assertEquals(slugify("Large Print!"), "large-print");
  assertEquals(slugify("  Gift -- Edition "), "gift-edition");
  assertEquals(slugify("pocket"), "pocket");
  assertEquals(slugify("???"), "");
});

Deno.test("editionHref: edition param only when named", () => {
  assertEquals(
    editionHref("a-christmas-carol", null),
    "?book=a-christmas-carol",
  );
  assertEquals(editionHref("a b", "pocket"), "?book=a%20b&edition=pocket");
});

Deno.test("prettySize: two lengths read as W × H unit", () => {
  assertEquals(prettySize("5.25in 8in"), "5.25 × 8 in");
  assertEquals(prettySize("148mm 210mm"), "148 × 210 mm");
  assertEquals(prettySize("6in 230mm"), "6in × 230mm");
  assertEquals(prettySize("A5"), "A5");
});

Deno.test("firstSpanLine: first span naming the edition; null = default", () => {
  const spans = [
    { line: 4, endLine: 6, editions: ["pocket"] },
    { line: 9, endLine: 11, editions: ["default", "pocket"] },
  ];
  assertEquals(firstSpanLine(spans, "pocket"), 4);
  assertEquals(firstSpanLine(spans, null), 9);
  assertEquals(firstSpanLine(spans, "gift"), null);
});

Deno.test("appHref: only what differs from the defaults", () => {
  assertEquals(
    appHref({ book: "a", edition: null, mode: "write", view: null, line: 1 }),
    "?book=a",
  );
  assertEquals(
    appHref({
      book: "a",
      edition: "pocket",
      mode: "publish",
      view: "publish:print",
      line: 40,
      lib: "c0ffee42",
    }),
    "?book=a&edition=pocket&lib=c0ffee42&mode=publish&view=publish%3Aprint#line=40",
  );
});

Deno.test("lineFromHash: only #line=N", () => {
  assertEquals(lineFromHash("#line=12"), 12);
  assertEquals(lineFromHash(""), null);
  assertEquals(lineFromHash("#line=x"), null);
});
