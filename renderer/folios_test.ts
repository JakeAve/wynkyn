import { assertEquals } from "@std/assert";
import type { NumberingStyle } from "../metadata/types.ts";
import "./folios.js";

type Zone = "front" | "body" | "back";
type ZoneNumbering = { style: NumberingStyle; show: boolean };
type PageNumberingConfig = Record<Zone, ZoneNumbering>;
type PageFacts = {
  zone: Zone | null;
  display: boolean;
  blank: boolean;
  empty: boolean;
  chapterTitles: string[];
  partTitles: string[];
  anchors: string[];
};
type PageEntry = Omit<PageFacts, "zone" | "chapterTitles" | "partTitles"> & {
  index: number;
  zone: Zone;
  folio: number;
  folioText: string;
  chapterTitle: string;
  partTitle: string;
};
type Seed = Record<string, string>;
type PageProblem = { page: number | null; message: string };
type RenderResult = { map: PageEntry[]; seed: Seed; problems: PageProblem[] };

const {
  formatFolio,
  buildPageMap,
  anchorFolios,
  checkPageMap,
  digest,
  settle,
} = (globalThis as unknown as {
  BookPageMap: {
    formatFolio(n: number, style: NumberingStyle): string;
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
      ["body", "5", "Two", "Part"],
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
