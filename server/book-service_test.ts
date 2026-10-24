// server/book-service_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import { BookService, ServiceError } from "./book-service.ts";
import { diskStore } from "./store.ts";

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
    assertEquals(
      await status(service.addImage("demo-book", "b.png", bytes("y"), "../x")),
      400,
    );
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
