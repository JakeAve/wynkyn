// server/book-service_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import { BookService, ServiceError } from "./book-service.ts";
import { diskStore } from "./store.ts";
import { imageFiles } from "./pipeline.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test("images: list by slug; add names from the file, never overwrites", async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/demo-book/images`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${root}/demo-book/manuscript.md`, "{title}\nX\n");
  await Deno.writeTextFile(`${dir}/ornament.svg`, "<svg/>");
  await Deno.writeTextFile(`${dir}/marleys-ghost.jpg`, "jpg");
  await Deno.writeTextFile(`${dir}/notes.txt`, "not an image");
  const service = new BookService({ store: diskStore(root) });
  try {
    assertEquals(await service.images("demo-book"), [
      { slug: "marleys-ghost", name: "marleys-ghost.jpg" },
      { slug: "ornament", name: "ornament.svg" },
    ]);

    // Taken under another extension: the .png would be shadowed, so -2.
    assertEquals(
      await service.addImage("demo-book", "Marley's Ghost.png", bytes("png")),
      { slug: "marleys-ghost-2", name: "marleys-ghost-2.png" },
    );
    assertEquals(await Deno.readTextFile(`${dir}/marleys-ghost.jpg`), "jpg");
    assertEquals(await Deno.readTextFile(`${dir}/marleys-ghost-2.png`), "png");

    // A given slug is used as is, refused when taken or malformed.
    assertEquals(
      await service.addImage("demo-book", "a.JPEG", bytes("x"), "plate_1"),
      { slug: "plate_1", name: "plate_1.jpeg" },
    );
    const status = async (p: Promise<unknown>) =>
      (await assertRejects(() => p, ServiceError)).status;
    assertEquals(
      await status(
        service.addImage("demo-book", "b.png", bytes("y"), "ornament"),
      ),
      409,
    );
    for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "a\u0007b"]) {
      assertEquals(
        await status(service.addImage("demo-book", "b.png", bytes("y"), bad)),
        400,
        JSON.stringify(bad),
      );
    }
    // Any slug BML allows that is safe as a file name; the resolver slices
    // at the last dot, so orchard.1943.png serves orchard.1943.
    for (const slug of ["orchard.1943", "Orchard 1943"]) {
      assertEquals(
        await service.addImage("demo-book", "b.png", bytes("y"), slug),
        { slug, name: `${slug}.png` },
      );
    }
    assertEquals(
      (await imageFiles(diskStore(root), "demo-book"))["orchard.1943"],
      "orchard.1943.png",
    );
    assertEquals(
      await service.image("demo-book", "Orchard 1943.png"),
      bytes("y"),
    );
    // A file the renderer can't show neither lists nor takes its slug.
    await Deno.writeTextFile(`${dir}/harbour.tif`, "tif");
    assertEquals(
      await service.addImage("demo-book", "h.png", bytes("h"), "harbour"),
      { slug: "harbour", name: "harbour.png" },
    );
    assertEquals(await Deno.readTextFile(`${dir}/harbour.tif`), "tif");
    const heic = await assertRejects(
      () => service.addImage("demo-book", "x.heic", bytes("z")),
      ServiceError,
    );
    assertEquals(heic.status, 415);
    assertEquals(
      heic.message,
      "Only PNG, JPEG, WebP or SVG images can go in a book",
    );
    assertEquals(await Deno.readTextFile(`${dir}/ornament.svg`), "<svg/>");
    assertEquals(
      await status(service.images("no-such-book")),
      404,
    );
  } finally {
    await service.stop();
    await Deno.remove(root, { recursive: true });
  }
});
