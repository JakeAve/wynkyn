import { assertEquals, assertThrows } from "jsr:@std/assert";
import { nUp, parseDims } from "./imposition.ts";

Deno.test("parseDims: named sizes and explicit in/mm", () => {
  assertEquals(parseDims("legal"), { w: 8.5, h: 14 });
  assertEquals(parseDims("Letter"), { w: 8.5, h: 11 });
  assertEquals(parseDims("5.25in 8in"), { w: 5.25, h: 8 });
  const a5 = parseDims("148mm 210mm");
  assertEquals(Math.round(a5.w * 100) / 100, 5.83);
  assertThrows(() => parseDims("huge"), Error, 'unknown size "huge"');
});

Deno.test("nUp: derived from sheet long side / page width, even only", () => {
  const legal = parseDims("legal");
  assertEquals(nUp(legal, { w: 3.5, h: 8.5 }), 4); // spec §7.7 example
  assertEquals(nUp(legal, { w: 5.5, h: 8.5 }), 2); // spec §7.7 example
  assertEquals(nUp(legal, { w: 4.5, h: 8.5 }), 2); // floor(14/4.5)=3 → 2
  assertEquals(nUp(parseDims("letter"), { w: 5.5, h: 8.5 }), 2); // 11/5.5 = 2 exactly
  assertEquals(nUp(parseDims("letter"), { w: 6, h: 8.5 }), 0); // only 1 fits
  assertEquals(nUp(parseDims("letter"), { w: 4, h: 9 }), 0); // too tall
});
