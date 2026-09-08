import { assertEquals } from "@std/assert";
import { editionHref, editionLabel, slugify } from "./editions.ts";

Deno.test("editionLabel: unnamed edition, else prettified slug", () => {
  assertEquals(editionLabel(null), "Unnamed edition");
  assertEquals(editionLabel("large-print"), "Large Print");
});

Deno.test("slugify: lowercase, hyphens, no leading/trailing/double hyphens", () => {
  assertEquals(slugify("Large Print!"), "large-print");
  assertEquals(slugify("  Gift -- Edition "), "gift-edition");
  assertEquals(slugify("pocket"), "pocket");
  assertEquals(slugify("???"), "");
});

Deno.test("editionHref: edition param only when named", () => {
  assertEquals(
    editionHref("a-christmas-carol", null),
    "?book=a-christmas-carol",
  );
  assertEquals(editionHref("a b", "pocket"), "?book=a%20b&edition=pocket");
});
