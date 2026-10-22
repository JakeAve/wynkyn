import { assert, assertEquals } from "@std/assert";
import { installedFonts, missingFonts } from "./local-fonts.ts";

Deno.test("missingFonts: Google families are never missing", async () => {
  assertEquals(
    await missingFonts({ fonts: { body: "EB Garamond", display: "Girassol" } }),
    [],
  );
});

Deno.test("missingFonts: a family nobody serves or installed is", async () => {
  assertEquals(
    await missingFonts({
      fonts: { body: "EB Garamond", odd: "No Such Face 1911", blank: "" },
    }),
    ["No Such Face 1911"],
  );
});

Deno.test({
  name: "installedFonts: lists macOS's own faces, so they are not missing",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const installed = await installedFonts();
    assert(installed.includes("Helvetica"), installed.slice(0, 5).join(", "));
    assert(!installed.some((f) => f.startsWith(".")));
    assertEquals(await missingFonts({ fonts: { body: "Helvetica" } }), []);
  },
});
