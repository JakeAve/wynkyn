// server/pipeline_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { buildBook, listBooks, toHtml } from "./pipeline.ts";

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
  assertEquals(b.pageNumbering.body.show, true);
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

Deno.test("buildBook accepts an image url prefix override", async () => {
  const b = await buildBook(ROOT, "demo-book", {
    imageUrlPrefix: "file:///abs/images",
  });
  assert(
    !b.html.includes('"/books/demo-book/images'),
    "default prefix must not appear",
  );
});

Deno.test("buildBook with an edition: same HTML, that edition's CSS", async () => {
  const base = await buildBook(ROOT, "demo-book");
  const pocket = await buildBook(ROOT, "demo-book", { edition: "pocket" });
  assertEquals(base.edition, null);
  assertEquals(pocket.edition, "pocket");
  assertEquals(pocket.html, base.html);
  assert(base.pagedCss.includes("5.5in 8.5in"));
  assert(pocket.pagedCss.includes("3.5in 5in"));
  assert(pocket.fontLinks.includes("family=Crimson+Pro"));
  await assertRejects(
    () => buildBook(ROOT, "demo-book", { edition: "no-such" }),
    Deno.errors.NotFound,
  );
});

Deno.test("toHtml drives Paged.js itself, through the page map", async () => {
  const b = await buildBook(ROOT, "demo-book");
  const html = toHtml(b);
  assert(html.includes("@license Paged.js v0.4.3")); // vendored, inlined
  assert(!html.includes("<script src="), "no external script loads");
  assert(html.includes("globalThis).BookPageMap")); // folios.js inlined
  assert(html.includes("BookPageMap.settle("));
  assert(html.includes(JSON.stringify(b.pageNumbering)));
  assert(
    !html.includes("after()"),
    "the driver, not PagedConfig.after, ends it",
  );
});

async function onlyBook(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/b/editions`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/b/manuscript.md`,
    "{chapter: one}\n\nShared text.\n\n{only: default}\nWide only.\n{/only}\n\n" +
      "{only: pocket | nosuch}\nPocket only.\n{/only}\n",
  );
  await Deno.writeTextFile(`${dir}/b/editions/pocket.json`, "{}");
  return dir;
}

Deno.test("buildBook: pocket edition drops {only: default} blocks", async () => {
  const dir = await onlyBook();
  try {
    const base = await buildBook(dir, "b");
    assert(base.html.includes("Wide only."));
    assert(!base.html.includes("Pocket only."));
    const pocket = await buildBook(dir, "b", { edition: "pocket" });
    assert(pocket.html.includes("Shared text."));
    assert(pocket.html.includes("Pocket only."));
    assert(!pocket.html.includes("Wide only."));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildBook: an {only} token no edition answers to is a diagnostic", async () => {
  const dir = await onlyBook();
  try {
    assertEquals((await buildBook(dir, "b")).diagnostics, [
      { line: 9, message: '{only} names unknown edition "nosuch"' },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
