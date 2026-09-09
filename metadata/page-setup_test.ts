import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  describePageSetup,
  fmtLength,
  isValidSize,
  nUp,
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

Deno.test("nUp: largest even count that fits, 0 when two do not", () => {
  assertEquals(nUp(parseDims("legal"), { w: 3.5, h: 8.5 }), 4);
  assertEquals(nUp(parseDims("legal"), { w: 7, h: 8.5 }), 2); // exact fit counts
  assertEquals(nUp(parseDims("legal"), { w: 5, h: 8.5 }), 2); // 2.8 rounds down to 2
  assertEquals(nUp(parseDims("letter"), { w: 6, h: 9 }), 0); // too tall for the short side
});

Deno.test("every named setup round-trips to its own page count", () => {
  for (const preset of SETUP_PRESETS) {
    const setup = resolvePageSetup({ size: preset.size, sheet: preset.sheet });
    assertEquals(setup.error, null, `${preset.id}: ${setup.error}`);
    assertEquals(setup.nUp, preset.across, `${preset.id} pages across`);
    assertEquals(setup.preset?.id, preset.id, `${preset.id} matches itself`);
    // Derived sizes must never round up past the sheet they came from.
    assert(
      setup.slackAcross >= 0 && setup.slackAcross < 0.01,
      `${preset.id} tiles its sheet (slack ${setup.slackAcross})`,
    );
  }
});

Deno.test("pageForSheet divides the long side, keeps the short one", () => {
  assertEquals(pageForSheet(parseDims("legal"), 4), { w: 3.5, h: 8.5 });
  assertEquals(pageForSheet(parseDims("letter"), 2), { w: 5.5, h: 8.5 });
});

Deno.test("resolvePageSetup derives the whole imposition", () => {
  const s = resolvePageSetup({
    size: "3.5in 8.5in",
    sheet: "legal",
    "folios-per-signature": 4,
    duplex: "long-edge",
  });
  assertEquals(s.error, null);
  assertEquals(s.nUp, 4);
  assertEquals(s.foliosPerSheet, 2);
  assertEquals(s.cutsPerSheet, 1);
  assertEquals(s.sheetsPerSignature, 2);
  assertEquals(s.pagesPerSignature, 16);
  assertEquals(s.duplex, "long-edge");
  assertEquals(s.slackAcross, 0);
  assertEquals(s.slackDown, 0);
  assertEquals(s.preset?.id, "quarter-legal");
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
  assertEquals(setupPresetFor("3.5in 8.5in", "legal")?.id, "quarter-legal");
  assertEquals(setupPresetFor("88.9mm 215.9mm", "legal")?.id, "quarter-legal");
  assertEquals(setupPresetFor("3.5in 8.5in", "letter"), null);
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
