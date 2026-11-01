import { assertEquals } from "@std/assert";
import { drawnFor, hug, turnsTo } from "./ornaments.ts";

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
