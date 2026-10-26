import { assertEquals } from "@std/assert";
import type { NumberingStyle } from "../metadata/types.ts";
import type { PageProblem, Seed } from "./page-map-types.ts";
import "./folios.js";

type Zone = "front" | "body" | "back";
type ZoneNumbering = { style: NumberingStyle; show: boolean };
type PageNumberingConfig = Record<Zone, ZoneNumbering> & {
  openers?: { show: boolean; position: string | null };
};
type PageFacts = {
  zone: Zone | null;
  display: boolean;
  blank: boolean;
  empty: boolean;
  opener: boolean;
  chapterTitles: string[];
  partTitles: string[];
  anchors: string[];
};
type PageEntry = Omit<PageFacts, "zone" | "chapterTitles" | "partTitles"> & {
  index: number;
  zone: Zone;
  head: boolean;
  folio: number;
  folioText: string;
  refText: string;
  chapterTitle: string;
  partTitle: string;
};
type RenderResult = { map: PageEntry[]; seed: Seed; problems: PageProblem[] };

const {
  formatFolio,
  formatNumber,
  buildPageMap,
  anchorFolios,
  checkPageMap,
  digest,
  settle,
} = (globalThis as unknown as {
  BookPageMap: {
    formatFolio(n: number, style: NumberingStyle): string;
    formatNumber(n: number, style: NumberingStyle): string;
    buildPageMap(f: PageFacts[], n: PageNumberingConfig): PageEntry[];
    anchorFolios(map: PageEntry[]): Seed;
    checkPageMap(map: PageEntry[], expected: string[]): PageProblem[];
    digest(map: PageEntry[]): {
      zones: Record<string, [number, number]>;
      anchors: Seed;
      blanks: number[];
    };
    settle(
      r: (seed: Seed) => Promise<RenderResult>,
      seed: Seed,
      maxPasses?: number,
    ): Promise<RenderResult & { passes: number }>;
  };
}).BookPageMap;

const numbering: PageNumberingConfig = {
  front: { style: "roman-lower", show: true },
  body: { style: "arabic", show: true },
  back: { style: "arabic", show: true },
};
const page = (p: Partial<PageFacts> = {}): PageFacts => ({
  zone: null,
  display: false,
  blank: false,
  empty: false,
  opener: false,
  chapterTitles: [],
  partTitles: [],
  anchors: [],
  ...p,
});

Deno.test("formatFolio covers every page style", () => {
  assertEquals(formatFolio(1994, "roman-upper"), "MCMXCIV");
  assertEquals(formatFolio(4, "roman-lower"), "iv");
  assertEquals(
    [1, 26, 27, 52, 703].map((n) => formatFolio(n, "alpha-lower")),
    ["a", "z", "aa", "az", "aaa"],
  );
  assertEquals(formatFolio(28, "alpha-upper"), "AB");
  assertEquals(formatFolio(7, "words"), "7");
  assertEquals(formatFolio(7, "none"), "");
});

Deno.test("formatNumber spells words for chapters and parts; the page map's folio doesn't", () => {
  assertEquals(formatNumber(7, "words"), "Seven");
  assertEquals(formatNumber(42, "words"), "Forty-Two");
  assertEquals(formatNumber(100, "words"), "100");
  assertEquals(
    formatNumber(1994, "roman-upper"),
    formatFolio(1994, "roman-upper"),
  );
});

Deno.test("front counts in roman, body restarts at 1, back continues", () => {
  const map = buildPageMap([
    page(), // first page, no zone: front
    page({ zone: "front", display: true }),
    page({ zone: "front" }),
    page({ zone: "body" }),
    page({ zone: "body" }),
    page({ zone: "back" }),
  ], numbering);
  assertEquals(map.map((p) => [p.zone, p.folio, p.folioText]), [
    ["front", 1, "i"],
    ["front", 2, ""],
    ["front", 3, "iii"],
    ["body", 1, "1"],
    ["body", 2, "2"],
    ["back", 3, "3"],
  ]);
  const hidden = buildPageMap([page({ zone: "body" })], {
    ...numbering,
    body: { style: "arabic", show: false },
  });
  assertEquals(hidden[0]?.folioText, "");
});

Deno.test("TOC/ref numbers ignore show: false, display pages and style none", () => {
  const map = buildPageMap([
    page({ zone: "front", display: true, anchors: ["title-page"] }),
    page({ zone: "front", anchors: ["preface"] }),
    page({ zone: "body", anchors: ["one"] }),
    page({ display: true, anchors: ["plate"] }),
    page({ zone: "back", anchors: ["notes"] }),
  ], {
    front: { style: "roman-lower", show: false },
    body: { style: "arabic", show: true },
    back: { style: "none", show: true },
  });
  assertEquals(map.map((p) => p.folioText), ["", "", "1", "", ""]);
  assertEquals(anchorFolios(map), {
    "title-page": "i",
    preface: "ii",
    one: "1",
    plate: "2",
    notes: "3",
  });
});

Deno.test("a plate counts, shows no folio, and titles carry past it", () => {
  const map = buildPageMap([
    page({ zone: "body", chapterTitles: ["One"], partTitles: ["Part"] }),
    page({ display: true }), // plate: inherits body
    page({ zone: "body", anchors: ["x"] }),
    page({ zone: "body", chapterTitles: ["Two", "Three"] }),
    page({ blank: true, empty: true }),
    page({ zone: "back" }),
  ], numbering);
  assertEquals(
    map.map((p) => [p.zone, p.folioText, p.chapterTitle, p.partTitle]),
    [
      ["body", "1", "One", "Part"],
      ["body", "", "", ""],
      ["body", "3", "One", "Part"],
      ["body", "4", "Two", "Part"],
      ["body", "", "", ""], // blank: neither folio nor head
      ["back", "6", "", ""],
    ],
  );
  assertEquals(anchorFolios(map), { x: "3" });
  assertEquals(digest(map), {
    zones: { body: [1, 5], back: [6, 6] },
    anchors: { x: "3" },
    blanks: [5],
  });
});

Deno.test("openers keep their folio but no running head; blanks lose both (Chicago)", () => {
  const map = buildPageMap([
    page({ zone: "body", opener: true, partTitles: ["Part"] }),
    page({ zone: "body" }),
    page({ blank: true, empty: true }), // forced recto
    page({ zone: "body", opener: true, chapterTitles: ["One"] }),
    page({ zone: "body" }),
    page({ zone: "back", opener: true }),
  ], numbering);
  assertEquals(
    map.map((p) => [p.folioText, p.refText, p.head, p.chapterTitle]),
    [
      ["1", "1", false, ""],
      ["2", "2", true, ""],
      ["", "3", false, ""],
      ["4", "4", false, ""],
      ["5", "5", true, "One"],
      ["6", "6", false, ""],
    ],
  );
  assertEquals(map[1]?.partTitle, "Part");
});

Deno.test("openers.show false drops the opener's folio, not its number (§4.7)", () => {
  const map = buildPageMap([
    page({ zone: "body", opener: true }),
    page({ zone: "body" }),
    page({ zone: "body", opener: true }),
  ], { ...numbering, openers: { show: false, position: null } });
  assertEquals(
    map.map((p) => [p.folioText, p.refText]),
    [["", "1"], ["2", "2"], ["", "3"]],
  );
});

Deno.test("checkPageMap flags stranded pages and missing anchors", () => {
  const map = buildPageMap([
    page({ zone: "body", anchors: ["a"] }),
    page({ empty: true }),
    page({ blank: true, empty: true }),
  ], numbering);
  assertEquals(checkPageMap(map, ["a", "b", "end"]), [
    { page: 2, message: "stranded page: no text or image" },
    { page: null, message: '"#b" is on no page' },
    { page: null, message: '"#end" is on no page: the render was cut short' },
  ]);
  assertEquals(checkPageMap(map, ["a"]), [
    { page: 2, message: "stranded page: no text or image" },
  ]);
});

Deno.test("settle stops at a fixed point and gives up after 3 passes", async () => {
  const result = (seed: Seed): RenderResult => ({
    map: [],
    seed,
    problems: [],
  });
  const converging = await settle(
    (seed) => Promise.resolve(result(seed.toc ? seed : { toc: "3" })),
    {},
  );
  assertEquals([converging.passes, converging.seed, converging.problems], [
    2,
    { toc: "3" },
    [],
  ]);

  const seen: Seed[] = [];
  const flipping = await settle((seed) => {
    seen.push(seed);
    return Promise.resolve(result({ toc: seed.toc === "3" ? "4" : "3" }));
  }, {});
  assertEquals(seen.length, 3);
  assertEquals(flipping.passes, 3);
  assertEquals(flipping.problems, [
    { page: null, message: "no fixed point after 3 passes" },
  ]);
});
