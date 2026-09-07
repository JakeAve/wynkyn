// server/editions_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import {
  classifyChange,
  createEdition,
  listEditions,
  metadataPath,
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
});

Deno.test("listEditions: unnamed first with summary, then named editions sorted", async () => {
  assertEquals(await listEditions(ROOT, "demo-book"), [
    { slug: null, summary: "5.5in 8.5in · EB Garamond · 11pt" },
    { slug: "pocket", summary: "3.5in 5in · Crimson Pro · 9pt" },
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
    assertEquals(await listEditions(root, "b"), [{ slug: null, summary: "" }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("createEdition: writes editions/<slug>.json, refuses a duplicate", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/b`);
  try {
    await createEdition(root, "b", "pocket", { page: { size: "A6" } });
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
