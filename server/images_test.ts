// server/images_test.ts
import { assertEquals } from "@std/assert";
import { freeSlug, imageSlug } from "./images.ts";

Deno.test("imageSlug: accents, apostrophes and runs fold into a slug", () => {
  assertEquals(imageSlug("Marley's Ghost.JPG"), {
    slug: "marleys-ghost",
    ext: "jpg",
  });
  assertEquals(imageSlug("  Café — Noël’s  .webp"), {
    slug: "cafe-noels",
    ext: "webp",
  });
  assertEquals(imageSlug("!!!.png"), { slug: "image", ext: "png" });
  assertEquals(imageSlug("x.heic"), null);
  assertEquals(imageSlug("noext"), null);
});

Deno.test("freeSlug: the slug when free, else the first free -n", () => {
  assertEquals(freeSlug("a", new Set()), "a");
  assertEquals(freeSlug("a", new Set(["a", "a-2"])), "a-3");
});
