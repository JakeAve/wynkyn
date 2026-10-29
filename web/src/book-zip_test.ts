import { assertEquals } from "@std/assert";
import { unzipSync } from "fflate";
import { type BookStore, diskStore } from "../../server/store.ts";
import { zipBook, zipLibrary } from "./book-zip.ts";

const root = new URL("../../server/testdata", import.meta.url).pathname;
const files = [
  "editions/pocket.json",
  "images/ornament.svg",
  "manuscript.md",
  "metadata.json",
];

for (
  const [name, zip, prefix] of [
    ["zipBook", zipBook, ""],
    ["zipLibrary", (s: BookStore, b: string) => zipLibrary(s, [b]), "Books/"],
  ] as const
) {
  Deno.test(`${name}: the book's files under ${prefix}<book>/, nothing else`, async () => {
    const out = unzipSync(await zip(diskStore(root), "demo-book"));
    assertEquals(
      Object.keys(out).sort(),
      files.map((f) => `${prefix}demo-book/${f}`),
    );
    assertEquals(
      new TextDecoder().decode(out[`${prefix}demo-book/manuscript.md`]),
      await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
    );
  });
}
