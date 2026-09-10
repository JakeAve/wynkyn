import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  describePageSetup,
  fmtLength,
  foldedSize,
  gridFor,
  isValidSize,
  parseDims,
  resolvePageSetup,
  tryParseDims,
} from "./page-setup.ts";

Deno.test("parseDims: named sizes, length pairs, unit conversion", () => {
  assertEquals(parseDims("legal"), { w: 8.5, h: 14 });
  assertEquals(parseDims("LEGAL"), { w: 8.5, h: 14 }); // named sizes are case-insensitive
  assertEquals(parseDims("5.5in 8.5in"), { w: 5.5, h: 8.5 });
  assertEquals(parseDims("254mm 508mm"), { w: 10, h: 20 });
  assertEquals(parseDims("72pt 144pt"), { w: 1, h: 2 });
  assertEquals(tryParseDims("nonsense"), null);
});

Deno.test("isValidSize matches the value space parseDims accepts", () => {
  assert(isValidSize("A5"));
  assert(isValidSize("148mm  210mm")); // extra whitespace ok
  assertFalse(isValidSize("5.5in")); // one length is not a size
  assertFalse(isValidSize("5.5 8.5")); // unitless
});

Deno.test("gridFor: even columns, the orientation that fits the most pages", () => {
  const grid = (sheet: string, w: number, h: number) => {
    const g = gridFor(parseDims(sheet), { w, h });
    return g === null ? null : [g.cols, g.rows, g.sheet.w > g.sheet.h];
  };
  // One row across the long side — unchanged by the move to a 2-D grid.
  assertEquals(grid("legal", 7, 8.5), [2, 1, true]); // exact fit counts
  assertEquals(grid("legal", 5, 8.5), [2, 1, true]); // 2.8 columns rounds to 2
  assertEquals(grid("legal", 3.5, 8.5), [4, 1, true]); // 4 across, still one row
  // Quartering: both sides halved, so the sheet turns portrait and stacks rows.
  assertEquals(grid("legal", 4.25, 7), [2, 2, false]);
  assertEquals(grid("letter", 4.25, 5.5), [2, 2, false]);
  // A tie goes to the single row: 2.75×5.5 on letter is 4-up either as 4×1
  // landscape or 2×2 portrait, and the single row needs no cut across.
  assertEquals(grid("letter", 2.75, 5.5), [4, 1, true]);
  assertEquals(grid("letter", 6, 9), null); // fits neither way
});

Deno.test("foldedSize halves the long side, quarters both, never rounding up", () => {
  assertEquals(foldedSize("legal", 2, 1), "7in 8.5in");
  assertEquals(foldedSize("letter", 2, 1), "5.5in 8.5in");
  // Quartering keeps the sheet's proportions — that is what makes it a quarter
  // rather than a strip: legal 8.5×14 → 4.25×7, the same 1.647 ratio.
  assertEquals(foldedSize("legal", 2, 2), "4.25in 7in");
  assertEquals(foldedSize("letter", 2, 2), "4.25in 5.5in");
  // A4 297/2 = 148.5mm exactly. Rounding that up would put the folded page over
  // the edge of the sheet it came from.
  assertEquals(foldedSize("A4", 2, 1), "148.5mm 210mm");
  assertEquals(foldedSize("A4", 2, 2), "105mm 148.5mm");
});

Deno.test("every folded size tiles the sheet it came off, with nothing over", () => {
  for (const sheet of ["letter", "legal", "tabloid", "A3", "A4", "A5"]) {
    for (const rows of [1, 2] as const) {
      const size = foldedSize(sheet, 2, rows);
      const s = resolvePageSetup({ size, sheet });
      assertEquals(s.error, null, `${sheet} ÷ ${rows}: ${s.error}`);
      assertEquals([s.cols, s.rows], [2, rows], `${sheet} ÷ ${rows} grid`);
      assert(
        s.slackAcross >= 0 && s.slackAcross < 0.01 && s.slackDown >= 0 &&
          s.slackDown < 0.01,
        `${sheet} ÷ ${rows} slack ${s.slackAcross}/${s.slackDown}`,
      );
    }
  }
});

Deno.test("resolvePageSetup derives the whole imposition", () => {
  const s = resolvePageSetup({
    size: "4.25in 7in",
    sheet: "legal",
    "folios-per-signature": 4,
    duplex: "long-edge",
  });
  assertEquals(s.error, null);
  assertEquals([s.nUp, s.cols, s.rows], [4, 2, 2]); // quartered: cut once, fold twice
  assertEquals(s.landscape, false); // both sides halved, so the sheet prints portrait
  assertEquals(s.foliosPerSheet, 2);
  assertEquals(s.cutsPerSheet, 1);
  assertEquals(s.sheetsPerSignature, 2);
  assertEquals(s.pagesPerSignature, 16);
  assertEquals(s.duplex, "long-edge");
  assertEquals(s.slackAcross, 0);
  assertEquals(s.slackDown, 0);
});

Deno.test("resolvePageSetup still lays strips out in one landscape row", () => {
  // 3.5×8.5 on legal is 4-up as four strips across — a valid custom setup, but
  // no longer one of the named ones, which quarter the sheet instead.
  const s = resolvePageSetup({ size: "3.5in 8.5in", sheet: "legal" });
  assertEquals([s.nUp, s.cols, s.rows], [4, 4, 1]);
  assertEquals(s.landscape, true);
  assertEquals(s.foliosPerSheet, 2);
});

Deno.test("resolvePageSetup applies §4.3 defaults and flag overrides", () => {
  const defaults = resolvePageSetup(undefined);
  assertEquals(
    [defaults.size, defaults.sheet, defaults.folios, defaults.duplex],
    ["5.5in 8.5in", "letter", 4, "short-edge"],
  );
  const overridden = resolvePageSetup(
    { size: "3.5in 8.5in", sheet: "letter", "folios-per-signature": 4 },
    { sheet: "legal", folios: 2, duplex: "none" },
  );
  assertEquals([overridden.sheet, overridden.folios, overridden.duplex], [
    "legal",
    2,
    "none",
  ]);
  assertEquals(overridden.nUp, 4);
});

Deno.test("resolvePageSetup reports leftover paper rather than hiding it", () => {
  const s = resolvePageSetup({ size: "5.25in 8in", sheet: "legal" });
  assertEquals(s.error, null);
  assertEquals(s.nUp, 2);
  assertEquals(+s.slackAcross.toFixed(3), 3.5);
  assertEquals(+s.slackDown.toFixed(3), 0.5);
});

Deno.test("resolvePageSetup never throws; every bad input names itself", () => {
  const cases: [Parameters<typeof resolvePageSetup>[0], string][] = [
    [{ size: "nonsense" }, 'unknown page size "nonsense"'],
    [{ sheet: "nonsense" }, 'unknown sheet size "nonsense"'],
    [{ "folios-per-signature": 0 }, "whole number"],
    [{ duplex: "sideways" as never }, "duplex must be"],
    [{ size: "6in 9in", sheet: "letter" }, "does not fit two-up"],
  ];
  for (const [page, fragment] of cases) {
    const s = resolvePageSetup(page);
    assert(
      s.error?.includes(fragment),
      `${JSON.stringify(page)} → ${s.error}`,
    );
    assertEquals(s.nUp, 0);
  }
});

Deno.test("describePageSetup stays short on a broken setup", () => {
  const ok = resolvePageSetup({ size: "3.5in 8.5in", sheet: "legal" });
  assertEquals(describePageSetup(ok), "3.5in × 8.5in · 4-up on legal");
  const tooBig = resolvePageSetup({ size: "6in 9in", sheet: "letter" });
  assertEquals(
    describePageSetup(tooBig),
    "6in × 9in · will not print on letter",
  );
  const bogus = resolvePageSetup({ size: "nope" });
  assertEquals(describePageSetup(bogus), "nope · unrecognized page size");
});

Deno.test("fmtLength renders in the unit asked for, without trailing zeros", () => {
  assertEquals(fmtLength(3.5), "3.5in");
  assertEquals(fmtLength(1, "mm"), "25.4mm");
  assertEquals(fmtLength(0), "0in");
});
