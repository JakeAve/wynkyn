import { assertEquals, assertNotEquals } from "@std/assert";
import { cacheId, renderHash } from "./preview-cache.ts";

const base = {
  html: "<p>a</p>",
  baseCss: "a{}",
  domCss: "b{}",
  pagedCss: "c{}",
  fontLinks: "",
};

Deno.test("renderHash: a folio style change alone changes the hash", () => {
  const a = { ...base, pageNumbering: { body: { style: "arabic" } } };
  const b = { ...base, pageNumbering: { body: { style: "roman-lower" } } };
  assertNotEquals(renderHash(a), renderHash(b));
});

Deno.test("renderHash: same input yields same hash", () => {
  assertEquals(renderHash(base), renderHash({ ...base }));
});

Deno.test("renderHash: a one-character change in any field changes the hash", () => {
  const original = renderHash(base);
  assertNotEquals(original, renderHash({ ...base, html: "<p>b</p>" }));
  assertNotEquals(original, renderHash({ ...base, baseCss: "a{}}" }));
  assertNotEquals(original, renderHash({ ...base, domCss: "b{}}" }));
  assertNotEquals(original, renderHash({ ...base, pagedCss: "c{}}" }));
  assertNotEquals(original, renderHash({ ...base, fontLinks: "x" }));
});

Deno.test("cacheId: book + | + edition-or-empty", () => {
  assertEquals(cacheId("a", null), "a|");
  assertEquals(cacheId("a", "pocket"), "a|pocket");
});
