import { assertEquals } from "@std/assert";
import { upgradePageSetup } from "./upgrade.ts";

Deno.test("upgradePageSetup folds a print section into page", () => {
  assertEquals(
    upgradePageSetup({
      page: { size: "3.5in 8.5in" },
      print: {
        "sheet-size": "legal",
        "folios-per-signature": 2,
        duplex: "long-edge",
      },
    }),
    {
      page: {
        size: "3.5in 8.5in",
        sheet: "legal",
        "folios-per-signature": 2,
        duplex: "long-edge",
      },
    },
  );
});

Deno.test("upgradePageSetup creates page when only print was set", () => {
  assertEquals(upgradePageSetup({ print: { "sheet-size": "legal" } }), {
    page: { sheet: "legal" },
  });
});

Deno.test("upgradePageSetup leaves an already-migrated file alone", () => {
  const meta = { page: { size: "A5", sheet: "A4" }, fonts: { body: "Inter" } };
  assertEquals(upgradePageSetup(meta), meta);
  assertEquals(upgradePageSetup({}), {});
});

Deno.test("upgradePageSetup lets page win over a stale print key", () => {
  assertEquals(
    upgradePageSetup({
      page: { sheet: "letter", "folios-per-signature": 3 },
      print: {
        "sheet-size": "legal",
        "folios-per-signature": 8,
        duplex: "none",
      },
    }),
    {
      page: { sheet: "letter", "folios-per-signature": 3, duplex: "none" },
    },
  );
});

Deno.test("upgradePageSetup preserves every other section", () => {
  const upgraded = upgradePageSetup({
    fonts: { body: "EB Garamond" },
    notes: { placement: "endnote" },
    print: { duplex: "none" },
  });
  assertEquals(upgraded.fonts, { body: "EB Garamond" });
  assertEquals(upgraded.notes, { placement: "endnote" });
  assertEquals(upgraded.print, undefined);
});
