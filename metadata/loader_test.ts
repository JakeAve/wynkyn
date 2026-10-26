import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadMetadata, parseMetadataText } from "./loader.ts";

Deno.test("loads a valid metadata file", async () => {
  const meta = await loadMetadata("metadata/testdata/valid/metadata.json");
  assertEquals(meta?.page?.size, "5.5in 8.5in");
  assertEquals(meta?.fonts?.["display"], "Playfair Display");
  assertEquals(meta?.notes?.placement, "footnote");
  // The fixture is deliberately still in the pre-merge shape: loading upgrades
  // its `print` section into `page` (metadata/upgrade.ts).
  assertEquals(meta?.page?.sheet, "legal");
  assertEquals(meta?.page?.["folios-per-signature"], 4);
  assertEquals(meta?.print, undefined);
});

Deno.test("returns null when the file is missing (spec §5.2)", async () => {
  assertEquals(
    await loadMetadata("metadata/testdata/nonexistent/metadata.json"),
    null,
  );
});

Deno.test("throws a descriptive error on malformed JSON", async () => {
  await assertRejects(
    () => loadMetadata("metadata/testdata/invalid/metadata.json"),
    Error,
    "metadata/testdata/invalid/metadata.json",
  );
});

Deno.test("JSON that isn't an object is a metadata error, not a TypeError", () => {
  for (const text of ["null", "[]", "3"]) {
    assertThrows(
      () => parseMetadataText(text, "m.json"),
      Error,
      "Invalid metadata in m.json: not a JSON object",
    );
  }
});
