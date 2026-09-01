import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatDiagnostics, toHtml } from "./bml.ts";
import { buildBook } from "./server/pipeline.ts";

Deno.test("bml cli: diagnostics format and standalone html", async () => {
  assertEquals(
    formatDiagnostics("x", [{ line: 3, message: "bad" }]),
    "books/x/manuscript.md:3: bad",
  );
  const html = toHtml(await buildBook("server/testdata", "demo-book"));
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "paged.polyfill.js");
  assertStringIncludes(html, "@page");
});
