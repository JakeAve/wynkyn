import { assertEquals } from "@std/assert";
import { unzipSync } from "fflate";
import { diskStore } from "../../server/store.ts";
import { zipBook } from "./book-zip.ts";

Deno.test("zipBook: the book's files under <book>/, nothing else", async () => {
  const root = new URL("../../server/testdata", import.meta.url).pathname;
  const zip = unzipSync(await zipBook(diskStore(root), "demo-book"));
  assertEquals(Object.keys(zip).sort(), [
    "demo-book/editions/pocket.json",
    "demo-book/images/ornament.svg",
    "demo-book/manuscript.md",
    "demo-book/metadata.json",
  ]);
  assertEquals(
    new TextDecoder().decode(zip["demo-book/manuscript.md"]),
    await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
  );
});
