// server/pipeline_test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { buildBook, listBooks } from "./pipeline.ts";

const ROOT = new URL("./testdata", import.meta.url).pathname;

Deno.test("listBooks finds directories containing manuscript.md", async () => {
  assertEquals(await listBooks(ROOT), ["demo-book"]);
});

Deno.test("buildBook produces html, css, font links, and title", async () => {
  const b = await buildBook(ROOT, "demo-book");
  assertEquals(b.book, "demo-book");
  assertEquals(b.bookTitle, "Demo Book");
  assert(b.html.includes("Chapter One"));
  assert(b.html.includes("/books/demo-book/images/ornament.svg"));
  assert(b.baseCss.length > 0);
  assert(b.domCss.length > 0);
  assert(b.pagedCss.includes("@page"));
  assert(b.fontLinks.includes("family=EB+Garamond"));
  assertEquals(b.diagnostics, []);
});

Deno.test("buildBook picks images by spec extension priority", async () => {
  // svg beats png beats jpg (spec §4.11 item 8)
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/twin/images`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/twin/manuscript.md`,
    "{chapter: one}\n\n{illustration: pic}\nCaption\n",
  );
  await Deno.writeTextFile(`${dir}/twin/images/pic.png`, "png");
  await Deno.writeTextFile(`${dir}/twin/images/pic.jpg`, "jpg");
  const b = await buildBook(dir, "twin");
  assert(b.html.includes("/books/twin/images/pic.png"));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("buildBook rejects for a missing book", async () => {
  await assertRejects(() => buildBook(ROOT, "no-such-book"));
});
