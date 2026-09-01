import { assertEquals, assertRejects } from "@std/assert";
import { loadMetadata } from "./loader.ts";

Deno.test("loads a valid metadata.json", async () => {
  const meta = await loadMetadata("metadata/testdata/valid");
  assertEquals(meta?.page?.size, "5.5in 8.5in");
  assertEquals(meta?.fonts?.["display"], "Playfair Display");
  assertEquals(meta?.print?.["folios-per-signature"], 4);
  assertEquals(meta?.notes?.placement, "footnote");
});

Deno.test("returns null when metadata.json is missing (spec §5.2)", async () => {
  assertEquals(await loadMetadata("metadata/testdata/nonexistent"), null);
});

Deno.test("throws a descriptive error on malformed JSON", async () => {
  await assertRejects(
    () => loadMetadata("metadata/testdata/invalid"),
    Error,
    "metadata/testdata/invalid/metadata.json",
  );
});
