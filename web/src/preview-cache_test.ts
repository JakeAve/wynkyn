import { assertEquals, assertNotEquals } from "@std/assert";
import { cacheId, renderHash } from "./preview-cache.ts";

const base = {
  html: "<p>a</p>",
  baseCss: "a{}",
  domCss: "b{}",
  pagedCss: "c{}",
  fontLinks: "",
};

Deno.test("renderHash: same input yields same hash", async () => {
  assertEquals(await renderHash(base), await renderHash({ ...base }));
});

Deno.test("renderHash: a one-character change in any field changes the hash", async () => {
  const original = await renderHash(base);
  assertNotEquals(original, await renderHash({ ...base, html: "<p>b</p>" }));
  assertNotEquals(original, await renderHash({ ...base, baseCss: "a{}}" }));
  assertNotEquals(original, await renderHash({ ...base, domCss: "b{}}" }));
  assertNotEquals(original, await renderHash({ ...base, pagedCss: "c{}}" }));
  assertNotEquals(original, await renderHash({ ...base, fontLinks: "x" }));
});

Deno.test("cacheId: book + | + edition-or-empty", () => {
  assertEquals(cacheId("a", null), "a|");
  assertEquals(cacheId("a", "pocket"), "a|pocket");
});
