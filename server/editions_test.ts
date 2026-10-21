// server/editions_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import {
  classifyChange,
  createEdition,
  editionToken,
  listEditions,
  metadataPath,
  renameOnlyToken,
  safeName,
  summaryOf,
} from "./editions.ts";

const ROOT = new URL("./testdata", import.meta.url).pathname;

Deno.test("metadataPath: unnamed edition is metadata.json, named is editions/<slug>.json", () => {
  assertEquals(metadataPath("books", "b"), "books/b/metadata.json");
  assertEquals(metadataPath("books", "b", null), "books/b/metadata.json");
  assertEquals(
    metadataPath("books", "b", "pocket"),
    "books/b/editions/pocket.json",
  );
});

Deno.test("safeName rejects separators, dot-dot, and leading dots", () => {
  assertEquals(safeName("pocket"), true);
  assertEquals(safeName("large-print"), true);
  assertEquals(safeName("../x"), false);
  assertEquals(safeName("a/b"), false);
  assertEquals(safeName(".hidden"), false);
  assertEquals(safeName(""), false);
});

Deno.test("classifyChange: shared files, unnamed edition, named edition, noise", () => {
  assertEquals(classifyChange(["manuscript.md"]), { kind: "shared" });
  assertEquals(classifyChange(["images", "x.png"]), { kind: "shared" });
  assertEquals(classifyChange(["metadata.json"]), {
    kind: "edition",
    edition: null,
  });
  assertEquals(classifyChange(["editions", "pocket.json"]), {
    kind: "edition",
    edition: "pocket",
  });
  assertEquals(classifyChange(["editions", "pocket.json.swp"]), null);
  // Atomic writes land via <path>.tmp; only the rename onto the path counts.
  assertEquals(classifyChange(["manuscript.md.tmp"]), null);
  assertEquals(classifyChange(["metadata.json.tmp"]), null);
  assertEquals(classifyChange(["editions", "pocket.json.tmp"]), null);
  assertEquals(classifyChange(["editions", "deep", "pocket.json"]), null);
  assertEquals(classifyChange(["render.html"]), null);
  assertEquals(classifyChange([]), null);
});

Deno.test("summaryOf: page size · resolved body font · body size, skipping blanks", () => {
  assertEquals(
    summaryOf({
      page: { size: "5.5in 8.5in" },
      fonts: { body: "EB Garamond" },
      elements: { body: { "font-family": "body", "font-size": "11pt" } },
    }),
    "5.5in 8.5in · EB Garamond · 11pt",
  );
  assertEquals(summaryOf({ page: { size: "A5" } }), "A5");
  assertEquals(summaryOf({}), "");
  // With a sheet configured the row leads with the imposition instead (§4.3),
  // and says so plainly when the page cannot be printed on that sheet.
  assertEquals(
    summaryOf({ page: { size: "3.5in 8.5in", sheet: "legal" } }),
    "3.5in × 8.5in · 4-up on legal",
  );
  assertEquals(
    summaryOf({ page: { size: "6in 9in", sheet: "letter" } }),
    "6in × 9in · will not print on letter",
  );
  // A legacy print section still resolves, via the on-load upgrade.
  assertEquals(
    summaryOf({
      page: { size: "3.5in 8.5in" },
      print: { "sheet-size": "legal" },
    }),
    "3.5in × 8.5in · 4-up on legal",
  );
});

Deno.test("listEditions: unnamed first with summary, then named editions sorted", async () => {
  assertEquals(await listEditions(ROOT, "demo-book"), [
    // demo-book names a sheet, so its row describes the imposition; pocket
    // does not, so its row stays at the page size.
    {
      slug: null,
      name: "Standard",
      summary: "5.5in × 8.5in · 2-up on letter · EB Garamond · 11pt",
      passages: 0,
    },
    {
      slug: "pocket",
      name: "Pocket",
      summary: "3.5in 5in · Crimson Pro · 9pt",
      passages: 0,
    },
  ]);
});

Deno.test("listEditions: a book without editions/ lists only the unnamed edition", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b`);
  await Deno.writeTextFile(
    `${root}/b/manuscript.md`,
    "{matter: half-title}\n{title}\nB\n",
  );
  try {
    assertEquals(await listEditions(root, "b"), [
      { slug: null, name: "Standard", summary: "", passages: 0 },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("createEdition: writes editions/<slug>.json, refuses a duplicate", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b`);
  try {
    // The default edition's display name stays with it.
    await createEdition(root, "b", "pocket", {
      name: "Hardcover",
      page: { size: "A6" },
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${root}/b/editions/pocket.json`)),
      { page: { size: "A6" } },
    );
    await assertRejects(
      () => createEdition(root, "b", "pocket", {}),
      Deno.errors.AlreadyExists,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("editionToken: null is the default token, a slug is itself", () => {
  assertEquals(editionToken(null), "default");
  assertEquals(editionToken("pocket"), "pocket");
});

Deno.test("listEditions: default name from metadata, title-cased slugs, {only} passages", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b/editions`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/b/manuscript.md`,
    "{chapter: one}\n\n{only: large-print | default}\nA\n{/only}\n\n" +
      "{only: large-print}\nB\n{/only}\n",
  );
  await Deno.writeTextFile(`${root}/b/metadata.json`, '{"name":"Hardcover"}');
  await Deno.writeTextFile(`${root}/b/editions/large-print.json`, "{}");
  try {
    assertEquals(await listEditions(root, "b"), [
      { slug: null, name: "Hardcover", summary: "", passages: 1 },
      { slug: "large-print", name: "Large Print", summary: "", passages: 2 },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("renameOnlyToken: rewrites only whole tokens in {only} opening lines", () => {
  const src = [
    "{only: pocket}",
    "pocket stays in prose",
    "{/only}",
    "{only: large | pocket}",
    "{only | pocket}",
    "{only: pocket-2 | xpocket}",
    "{chapter: pocket}",
    "{only: a | key: pocket}",
  ].join("\r\n");
  assertEquals(
    renameOnlyToken(src, "pocket", "travel"),
    [
      "{only: travel}",
      "pocket stays in prose",
      "{/only}",
      "{only: large | travel}",
      "{only | travel}",
      "{only: pocket-2 | xpocket}",
      "{chapter: pocket}",
      "{only: a | key: pocket}",
    ].join("\r\n"),
  );
});
