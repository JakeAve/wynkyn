import { assertEquals } from "@std/assert";

// Paged.js 0.4.3, byte-identical to https://unpkg.com/pagedjs@0.4.3/dist/paged.js.
// To upgrade: replace vendor/pagedjs/paged.js (and LICENSE), run
// `shasum -a 256 vendor/pagedjs/paged.js`, paste it here, update the version
// in CLAUDE.md, then read the golden page-map diff from `deno task test`.
const PAGED_JS_SHA256 =
  "4cae0c875c89084b353ceee87bcc742388de3133f2bbf48830b63f1d2d357e4f";

Deno.test("vendored Paged.js matches the pinned checksum", async () => {
  const bytes = await Deno.readFile(
    new URL("../vendor/pagedjs/paged.js", import.meta.url),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  assertEquals(
    [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    PAGED_JS_SHA256,
  );
});
