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
  assertStringIncludes(html, "@license Paged.js v0.4.3");
  assertStringIncludes(html, "@page");
});

async function bml(root: string, ...args: string[]) {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "bml.ts",
      ...args,
    ],
    env: { BML_BOOKS: root },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

Deno.test("bml cli: edition new, render --edition, list shows editions", async () => {
  const root = await Deno.makeTempDir();
  const src = new URL("./server/testdata/demo-book/", import.meta.url);
  await Deno.mkdir(`${root}/demo-book`);
  for (const f of ["manuscript.md", "metadata.json"]) {
    await Deno.copyFile(new URL(f, src), `${root}/demo-book/${f}`);
  }
  try {
    const created = await bml(root, "edition", "demo-book", "new", "pocket");
    assertEquals(created.code, 0, created.err);
    const pocket = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/editions/pocket.json`),
    );
    assertEquals(pocket.page.size, "5.5in 8.5in"); // copied from the unnamed edition

    const dup = await bml(root, "edition", "demo-book", "new", "pocket");
    assertEquals(dup.code, 1);
    assertStringIncludes(dup.err, "already exists");

    const rendered = await bml(
      root,
      "render",
      "demo-book",
      "--edition",
      "pocket",
    );
    assertEquals(rendered.code, 0, rendered.err);
    assertStringIncludes(rendered.out, `${root}/demo-book/render.pocket.html`);
    await Deno.stat(`${root}/demo-book/render.pocket.html`);

    const list = await bml(root, "list");
    assertStringIncludes(list.out, "demo-book\n  └ pocket");

    const checkMissing = await bml(
      root,
      "check",
      "demo-book",
      "--edition",
      "nosuch",
    );
    assertEquals(checkMissing.code, 0, checkMissing.err);
    assertStringIncludes(checkMissing.out, "demo-book: 0 diagnostic(s)");

    const renderMissing = await bml(
      root,
      "render",
      "demo-book",
      "--edition",
      "nosuch",
    );
    assertEquals(renderMissing.code, 1);
    assertStringIncludes(
      renderMissing.err,
      "no such edition: demo-book/nosuch",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
