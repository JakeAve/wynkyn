import { assertEquals } from "@std/assert";
import { BUILD_ID } from "./build-id.ts";

const SOURCES = [
  "../vendor/pagedjs/paged.js",
  "./folios.js",
  "./plates.js",
];

Deno.test("BUILD_ID matches the layout code it names", async () => {
  const parts = await Promise.all(
    SOURCES.map((p) => Deno.readFile(new URL(p, import.meta.url))),
  );
  const bytes = await new Blob(parts).arrayBuffer();
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  if (Deno.env.get("UPDATE_GOLDEN")) {
    const file = new URL("./build-id.ts", import.meta.url);
    const src = await Deno.readTextFile(file);
    await Deno.writeTextFile(
      file,
      src.replace(/BUILD_ID = "[0-9a-f]*"/, `BUILD_ID = "${hex}"`),
    );
    return;
  }
  assertEquals(
    BUILD_ID,
    hex,
    "stale: UPDATE_GOLDEN=1 deno test -A renderer/build-id_test.ts",
  );
});
