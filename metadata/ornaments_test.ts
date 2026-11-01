import { assertEquals } from "@std/assert";
import { drawnFor, hug, pageOrnaments, turnsTo } from "./ornaments.ts";

Deno.test("ornaments: art turns within its ring and hugs its own edge", () => {
  const o = { image: "a", "drawn-for": "bottom-left" as const };
  assertEquals(turnsTo(o, "bottom-left"), 0);
  assertEquals(turnsTo(o, "top-left"), 1);
  assertEquals(turnsTo(o, "bottom-right"), 3);
  // A corner's drawn-for means nothing on an edge.
  assertEquals(drawnFor(o, "right"), "top");
  assertEquals(turnsTo(o, "right"), 1);
  assertEquals(hug("bottom-left"), "left bottom");
  assertEquals(hug("top"), "center top");
  assertEquals(hug("left"), "left center");
});

Deno.test("pageOrnaments: defaults, a part's first page, missing art", () => {
  const files = { a: "a.png" };
  assertEquals(pageOrnaments(undefined, files), {});
  assertEquals(
    pageOrnaments({ chapter: [{ image: "gone", at: ["top"] }] }, files),
    {},
  );
  const rule = pageOrnaments({ part: [{ kind: "rule", pages: "all" }] }, files)
    .part![0]!;
  assertEquals(
    [rule.style, rule.width, rule.inset, rule.pages],
    ["single", "0.75pt", "6mm", "first"],
  );
  const spots = pageOrnaments({
    chapter: [{
      image: "a",
      "drawn-for": "bottom-left",
      at: ["top-left", "top"],
      pages: "all",
    }],
  }, files).chapter!;
  assertEquals(spots.map((s) => s.turns), [1, 0]);
  assertEquals([spots[0]!.file, spots[0]!.size, spots[0]!.pages], [
    "a.png",
    "25mm",
    "all",
  ]);
});
