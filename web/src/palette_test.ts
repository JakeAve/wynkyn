import { assertEquals } from "@std/assert";
import { type Item, rank, type RankContext } from "./palette.ts";

const item = (id: string, group: Item["group"], detail?: string): Item => ({
  id,
  label: id,
  group,
  detail,
  run() {},
});

const items = [
  item("Fonts", "Styles"),
  item("Export EPUB", "Commands", "Publish"),
  item("quote", "Sentinels", "Block quotation"),
  item("Chapter One", "Go to"),
];

const ctx = (over: Partial<RankContext> = {}): RankContext => ({
  mode: "write",
  recent: [],
  pages: 10,
  goToPage() {},
  ...over,
});

const ids = (r: Item[]) => r.map((i) => i.id);

Deno.test("rank orders groups by mode", () => {
  assertEquals(ids(rank(items, "", ctx())), [
    "quote",
    "Export EPUB",
    "Chapter One",
    "Fonts",
  ]);
  assertEquals(ids(rank(items, "", ctx({ mode: "style" }))), [
    "Export EPUB",
    "Fonts",
    "Chapter One",
    "quote",
  ]);
});

Deno.test("rank filters by label and detail", () => {
  assertEquals(ids(rank(items, "EPUB", ctx())), ["Export EPUB"]);
  assertEquals(ids(rank(items, "publish", ctx())), ["Export EPUB"]);
  assertEquals(ids(rank(items, " BLOCK ", ctx())), ["quote"]);
});

Deno.test("rank keeps only sentinels after {", () => {
  assertEquals(ids(rank(items, "{", ctx())), ["quote"]);
  assertEquals(ids(rank(items, "{quo", ctx())), ["quote"]);
  assertEquals(ids(rank(items, "{fonts", ctx())), []);
});

Deno.test("rank adds a page row for a number", () => {
  let went = 0;
  const [row] = rank(items, "Page 3", ctx({ goToPage: (n) => went = n }));
  assertEquals([row?.id, row?.label, row?.off], [
    "page",
    "Go to page 3",
    false,
  ]);
  row?.run();
  assertEquals(went, 3);
  assertEquals(rank(items, "11", ctx())[0]?.off, true);
  assertEquals(rank(items, "0", ctx())[0]?.off, true);
  assertEquals(ids(rank(items, "page", ctx())), []);
});

Deno.test("rank leads with recents on an empty query", () => {
  const recent = ["Fonts", "gone", "Chapter One"];
  assertEquals(ids(rank(items, "", ctx({ recent }))), [
    "Fonts",
    "Chapter One",
    "quote",
    "Export EPUB",
  ]);
  assertEquals(ids(rank(items, "o", ctx({ recent })))[0], "quote");
});
