import { assert, assertEquals } from "@std/assert";
import { FILES, siteFile } from "./build-site.ts";

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

Deno.test("the site's paths map to their files", () => {
  assertEquals(siteFile("/"), "web/site/index.html");
  assertEquals(siteFile("/app/"), "web/index.html");
  assertEquals(siteFile("/about"), "/about/"); // a bare directory: redirect
  assertEquals(siteFile("/llms.txt"), "web/llms.txt");
  assertEquals(siteFile("/nope"), null);
});
