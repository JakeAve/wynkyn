import { assertEquals } from "@std/assert";
import {
  isNewerSpec,
  SPEC_VERSION,
  upgradeMetadata,
  upgradePageSetup,
} from "./upgrade.ts";

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

Deno.test("upgradeMetadata stamps spec on an unversioned file only", () => {
  assertEquals(upgradeMetadata({ page: { size: "A5" } }), {
    spec: SPEC_VERSION,
    page: { size: "A5" },
  });
  assertEquals(upgradeMetadata({ spec: "9.0" }), { spec: "9.0" });
});

Deno.test("isNewerSpec compares numerically, not as strings", () => {
  assertEquals(isNewerSpec(undefined), false);
  assertEquals(isNewerSpec(SPEC_VERSION), false);
  assertEquals(isNewerSpec("0.5"), false);
  assertEquals(isNewerSpec("0.10"), true);
  assertEquals(isNewerSpec("1.0"), true);
});

// The number lives in three places on purpose (the app's constant, the house
// template, the spec's §3 heading); this is what keeps them one number.
Deno.test("SPEC_VERSION matches the template and the spec heading", async () => {
  const root = new URL("../", import.meta.url);
  const template = JSON.parse(
    await Deno.readTextFile(new URL("templates/metadata.json", root)),
  );
  assertEquals(template.spec, SPEC_VERSION);
  const spec = await Deno.readTextFile(
    new URL("book-renderer-spec.md", root),
  );
  assertEquals(
    spec.match(/^## 3\. .*Specification \(v([\d.]+)\)/m)?.[1],
    SPEC_VERSION,
  );
});
