import { assert } from "@std/assert";
import { FILES } from "./build-site.ts";

Deno.test("build:site copies only files that exist", async () => {
  for (const src of Object.keys(FILES)) {
    if (src === "web/app.js") continue; // built by build:web, not tracked
    assert(
      await Deno.stat(new URL(`../${src}`, import.meta.url)).then(
        () => true,
        () => false,
      ),
      src,
    );
  }
});
