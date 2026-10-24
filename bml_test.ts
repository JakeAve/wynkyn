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
    assertStringIncludes(
      list.out,
      "demo-book\n  └ default  Standard  5.5in × 8.5in",
    );
    assertStringIncludes(list.out, "\n  └ pocket  Pocket  5.5in × 8.5in");

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

Deno.test("bml check: {only} notes go to stderr; unknown tokens fail", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b`);
  const write = (text: string) =>
    Deno.writeTextFile(`${root}/b/manuscript.md`, text);
  try {
    await write("{chapter: one}\n\n{only: default}\nA\n{/only}\n");
    const ok = await bml(root, "check", "b");
    assertEquals(ok.code, 0, ok.err);
    assertStringIncludes(
      ok.err,
      `${root}/b/manuscript.md:3: experimental: {only}`,
    );
    assertStringIncludes(ok.out, "b: 0 diagnostic(s)");

    await write("{chapter: one}\n\n{only: pocket}\nA\n{/only}\n");
    const bad = await bml(root, "check", "b");
    assertEquals(bad.code, 1);
    assertStringIncludes(bad.err, '3: {only} names unknown edition "pocket"');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bml new --theme: the theme's fonts; unknown theme fails, writes nothing", async () => {
  const root = await Deno.makeTempDir();
  try {
    const made = await bml(root, "new", "x", "--theme", "caslon");
    assertEquals(made.code, 0, made.err);
    const meta = JSON.parse(await Deno.readTextFile(`${root}/x/metadata.json`));
    assertEquals(meta.fonts.body, "Libre Caslon Text");
    assertEquals(meta.fonts.display, "Libre Caslon Display");

    const house = await bml(root, "new", "h");
    assertEquals(house.code, 0, house.err);
    assertEquals(
      await Deno.readTextFile(`${root}/h/metadata.json`),
      await Deno.readTextFile("templates/metadata.json"),
    );

    const bad = await bml(root, "new", "y", "--theme", "nope");
    assertEquals(bad.code, 2);
    assertStringIncludes(bad.err, "no such theme: nope");
    assertEquals(await exists(`${root}/y`), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
