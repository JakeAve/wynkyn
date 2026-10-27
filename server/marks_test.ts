import { assertEquals } from "@std/assert";
import { resolveMarks } from "../metadata/page-setup.ts";
import {
  type Fold,
  impose,
  type ImposeConfig,
  parseDims,
  sidesFor,
} from "./imposition.ts";
import { type MarkLine, marksFor } from "./marks.ts";

const ON = resolveMarks({ show: true });
const base = { duplex: "short-edge", flip: "short-edge" } as const;
const marks = (pageCount: number, cfg: ImposeConfig) =>
  marksFor(impose(pageCount, cfg), cfg.page, ON);
const lines = (ls: MarkLine[], kind: MarkLine["kind"]) =>
  ls.filter((l) => l.kind === kind).map((l) => [l.x1, l.y1, l.x2, l.y2]);

Deno.test("marksFor: fold lines on the front only, each across what the earlier folds left", () => {
  const folds = (fold: Fold, sheet: string, page: { w: number; h: number }) => {
    const [m] = marks(4, {
      ...base,
      folios: 2,
      fold,
      sheet: parseDims(sheet),
      page,
    });
    assertEquals(m!.back.lines, []);
    return lines(m!.front.lines, "fold");
  };
  // Letter landscape 11 × 8.5: down the middle, stopping short of the edges.
  assertEquals(folds("folio", "letter", { w: 5.5, h: 8.5 }), [[
    5.5,
    0.2,
    5.5,
    8.3,
  ]]);
  // Legal portrait 8.5 × 14: head fold across, then the spine on the bottom half.
  assertEquals(folds("quarto", "legal", { w: 4.25, h: 7 }), [
    [0.2, 7, 8.3, 7],
    [4.25, 7, 4.25, 13.8],
  ]);
  // Legal landscape 14 × 8.5: v, h on the right half, v on its bottom quarter.
  assertEquals(
    marks(16, {
      ...base,
      folios: 4,
      fold: "octavo",
      sheet: parseDims("legal"),
      page: { w: 3.5, h: 4.25 },
    }).map((m) => lines(m.front.lines, "fold"))[0],
    [[7, 0.2, 7, 8.3], [7, 4.25, 13.8, 4.25], [10.5, 4.25, 10.5, 8.3]],
  );
  // cut 2-up on legal, centred: a folio's spine, between the pages.
  assertEquals(folds("cut", "legal", { w: 5.5, h: 8.5 }), [[7, 0.2, 7, 8.3]]);
});

Deno.test("marksFor: cut ticks only where the sheet is cut, inside the dead zone", () => {
  const cuts = (fold: Fold, page: { w: number; h: number }) => {
    const [m] = marks(4, {
      ...base,
      folios: 1,
      fold,
      sheet: parseDims("legal"),
      page,
    });
    assertEquals(lines(m!.back.lines, "cut"), []);
    return lines(m!.front.lines, "cut");
  };
  assertEquals(cuts("folio", { w: 5.5, h: 8.5 }), []);
  // cut 2-up, pages from x 1.5 to 12.5: ticks at the head and tail of each side.
  assertEquals(cuts("cut", { w: 5.5, h: 8.5 }), [
    [1.5, 0.2, 1.5, 0.45],
    [1.5, 8.05, 1.5, 8.3],
    [12.5, 0.2, 12.5, 0.45],
    [12.5, 8.05, 12.5, 8.3],
  ]);
  // leaves 2 × 2 on portrait legal: every row and column edge, middle included.
  const leaves = cuts("leaves", { w: 4, h: 6 });
  assertEquals(leaves.length, 12);
  assertEquals(leaves.filter(([x1, , x2]) => x1 === 4.25 && x2 === 4.25), [
    [4.25, 0.2, 4.25, 0.45],
    [4.25, 13.55, 4.25, 13.8],
  ]);
});

Deno.test("marksFor: sewing stations on each signature's centre spread, at the spine", () => {
  // Two 2-folio signatures: each centre recto (pages 5 and 13) is on the back
  // of its inner sheet, its spine on the fold at x 5.5 under either duplex.
  const page = { w: 5, h: 8 }; // centred head to tail in a 5.5 × 8.5 cell
  const stations = [0.75, 2.5, 4.25, 6, 7.75].map((y) => ({ x: 5.5, y }));
  for (const duplex of ["short-edge", "long-edge"] as const) {
    const imp = impose(16, {
      ...base,
      duplex,
      folios: 2,
      fold: "folio",
      sheet: parseDims("letter"),
      page,
    });
    // sidesFor hands each side its face's marks: front, back, front, back…
    const sides = sidesFor(imp, "duplex", false, marksFor(imp, page, ON));
    assertEquals(sides.map((s) => s.marks.dots), [
      [],
      [],
      [],
      stations,
      [],
      [],
      [],
      stations,
    ]);
  }
  // A quarto's centre recto (page 5) is upside down on the front's top row.
  const [q] = marks(8, {
    ...base,
    folios: 2,
    fold: "quarto",
    sheet: parseDims("legal"),
    page: { w: 4, h: 6.5 },
  });
  assertEquals(
    q!.front.dots,
    [0.75, 2.125, 3.5, 4.875, 6.25].map((y) => ({ x: 4.25, y })),
  );
  assertEquals(q!.back.dots, []);
});

Deno.test("marksFor: null marks give every face nothing", () => {
  const cfg = {
    ...base,
    folios: 1,
    fold: "cut",
    sheet: parseDims("legal"),
    page: { w: 5.5, h: 8.5 },
  } as const;
  const empty = { dots: [], lines: [] };
  assertEquals(marksFor(impose(8, cfg), cfg.page, null), [
    { front: empty, back: empty },
    { front: empty, back: empty },
  ]);
});
