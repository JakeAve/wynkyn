// web/src/fs-store_test.ts
import { assertEquals } from "@std/assert";
import { importBooks } from "./fs-store.ts";
import { memoryStore } from "../../testing/memory-store.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
// A picked file, as <input webkitdirectory> gives it: its path in the folder.
const picked = (path: string, body: string) => {
  const f = new File([body], path.slice(path.lastIndexOf("/") + 1));
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};

Deno.test("importBooks: an existing slug is skipped, its files untouched", async () => {
  const files = new Map([
    ["moby-dick/manuscript.md", bytes("ours\n")],
    ["moby-dick/metadata.json", bytes("{}\n")],
  ]);
  const got = await importBooks(memoryStore(files), [
    picked("books/Moby Dick/manuscript.md", "theirs\n"),
    picked("books/Moby Dick/metadata.json", '{"x":1}\n'),
    picked("books/Moby Dick/images/a.png", "png"),
    picked("books/Walden/manuscript.md", "walden\n"),
    picked("books/Walden/notes.txt", "left behind"),
  ]);
  assertEquals(got, { written: ["walden"], skipped: ["Moby Dick"] });
  assertEquals(text(files.get("moby-dick/manuscript.md")), "ours\n");
  assertEquals(text(files.get("moby-dick/metadata.json")), "{}\n");
  assertEquals(files.has("moby-dick/images/a.png"), false);
  assertEquals(text(files.get("walden/manuscript.md")), "walden\n");
  assertEquals(files.has("walden/notes.txt"), false);
});
