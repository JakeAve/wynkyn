import { assertAlmostEquals, assertEquals } from "@std/assert";
import { fitPageZoom, stepZoom } from "./preview-zoom.ts";

Deno.test("stepZoom walks the steps, from between them to the next one", () => {
  assertEquals(stepZoom(1, 1), 1.5);
  assertEquals(stepZoom(1, -1), 0.5);
  assertEquals(stepZoom(2, 1), 3);
  assertEquals(stepZoom(1.2, 1), 1.5);
  assertEquals(stepZoom(1.2, -1), 1);
  assertEquals(stepZoom(2.5, -1), 2);
  assertEquals(stepZoom(4, 1), 4);
  assertEquals(stepZoom(0.5, -1), 0.5);
  assertEquals(stepZoom(0.6, -1), 0.5);
});

Deno.test("fitPageZoom fits one page by its tighter side", () => {
  // A 400×600 page at fit 0.5 shows 200×300; a 500×450 pane takes it at 1.5×.
  assertAlmostEquals(fitPageZoom(500, 450, 400, 600, 0.5), 1.5);
  // A wide, short pane: the height decides; a tall, narrow one: the width.
  assertAlmostEquals(fitPageZoom(2000, 300, 400, 600, 0.5), 1);
  assertAlmostEquals(fitPageZoom(200, 2000, 400, 600, 0.5), 1);
});
