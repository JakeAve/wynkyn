import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  describePageSetup,
  fmtLength,
  gridFor,
  isValidSize,
  pageForSheet,
  parseDims,
  resolvePageSetup,
  SETUP_PRESETS,
  setupPresetFor,
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

Deno.test("every named setup round-trips to its own page count", () => {
  for (const preset of SETUP_PRESETS) {
    const setup = resolvePageSetup({ size: preset.size, sheet: preset.sheet });
    assertEquals(setup.error, null, `${preset.id}: ${setup.error}`);
    assertEquals(
      setup.nUp,
      preset.cols * preset.rows,
      `${preset.id} pages per sheet side`,
    );
    assertEquals([setup.cols, setup.rows], [preset.cols, preset.rows]);
    assertEquals(setup.preset?.id, preset.id, `${preset.id} matches itself`);
    // Derived sizes must never round up past the sheet they came from.
    assert(
      setup.slackAcross >= 0 && setup.slackAcross < 0.01,
      `${preset.id} tiles its sheet (slack ${setup.slackAcross})`,
    );
  }
});

Deno.test("pageForSheet: one row splits the long side, rows halve both", () => {
  assertEquals(pageForSheet(parseDims("legal"), 2, 1), { w: 7, h: 8.5 });
  assertEquals(pageForSheet(parseDims("letter"), 2, 1), { w: 5.5, h: 8.5 });
  // Quartering keeps the sheet's proportions — that is what makes it a quarter
  // rather than a strip: legal 8.5×14 → 4.25×7, the same 1.647 ratio.
  assertEquals(pageForSheet(parseDims("legal"), 2, 2), { w: 4.25, h: 7 });
  assertEquals(pageForSheet(parseDims("letter"), 2, 2), { w: 4.25, h: 5.5 });
});

Deno.test("quarter presets halve the sheet and keep its aspect ratio", () => {
  for (const preset of SETUP_PRESETS.filter((p) => p.rows === 2)) {
    const sheet = parseDims(preset.sheet);
    const page = parseDims(preset.size);
    const ratio = (d: { w: number; h: number }) =>
      Math.max(d.w, d.h) / Math.min(d.w, d.h);
    assert(
      Math.abs(ratio(sheet) - ratio(page)) < 0.005,
      `${preset.id}: sheet ${ratio(sheet)} vs page ${ratio(page)}`,
    );
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
  assertEquals(s.preset?.id, "quarter-legal");
});

Deno.test("resolvePageSetup still lays strips out in one landscape row", () => {
  // 3.5×8.5 on legal is 4-up as four strips across — a valid custom setup, but
  // no longer one of the named ones, which quarter the sheet instead.
  const s = resolvePageSetup({ size: "3.5in 8.5in", sheet: "legal" });
  assertEquals([s.nUp, s.cols, s.rows], [4, 4, 1]);
  assertEquals(s.landscape, true);
  assertEquals(s.foliosPerSheet, 2);
  assertEquals(s.preset, null);
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
  assertEquals(s.preset, null); // not one of the named setups
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

Deno.test("setupPresetFor recognizes a setup however its sizes are spelled", () => {
  assertEquals(setupPresetFor("4.25in 7in", "legal")?.id, "quarter-legal");
  assertEquals(
    setupPresetFor("107.95mm 177.8mm", "legal")?.id,
    "quarter-legal",
  );
  assertEquals(setupPresetFor("7in 8.5in", "legal")?.id, "half-legal");
  assertEquals(setupPresetFor("4.25in 7in", "letter"), null);
  assertEquals(setupPresetFor(undefined, "legal"), null);
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
