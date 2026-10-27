import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type CachedRender,
  cacheId,
  renderHash,
  restoredHash,
  restoredPageMap,
} from "./preview-cache.ts";

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

Deno.test("restoredPageMap: an old row without a map restores as []", () => {
  const old = { hash: "h", pages: "", styles: [], fontLinks: "" };
  assertEquals(restoredPageMap(old as unknown as CachedRender), {
    seed: {},
    problems: [],
    map: [],
  });
});

Deno.test("restoredPageMap: a row's map comes back as saved", () => {
  const entry = {
    index: 0,
    zone: "body" as const,
    display: false,
    blank: false,
    empty: false,
    opener: true,
    head: false,
    folio: 1,
    folioText: "",
    refText: "1",
    chapterTitle: "One",
    partTitle: "",
    anchors: ["one"],
  };
  const row: CachedRender = {
    hash: "h",
    pages: "",
    styles: [],
    fontLinks: "",
    seed: { one: "1" },
    problems: [],
    map: [entry],
  };
  assertEquals(restoredPageMap(row).map, [entry]);
});

Deno.test("restoredHash: a row without a map doesn't stand for its hash", () => {
  const old = { hash: "h", pages: "", styles: [], fontLinks: "" };
  assertEquals(restoredHash(old as unknown as CachedRender), null);
  const row = { ...old, seed: {}, problems: [], map: [] } as CachedRender;
  assertEquals(restoredHash(row), "h");
});
