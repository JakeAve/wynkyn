// web/src/fs-store_test.ts
import { assertEquals, assertRejects } from "@std/assert";
import { copyBooks, importBooks } from "./fs-store.ts";
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

Deno.test("copyBooks: a slug the target has is skipped, the rest copied whole", async () => {
  const src = new Map([
    ["moby-dick/manuscript.md", bytes("theirs\n")],
    ["walden/manuscript.md", bytes("walden\n")],
    ["walden/images/a.png", bytes("png")],
  ]);
  const dst = new Map([["moby-dick/manuscript.md", bytes("ours\n")]]);
  const got = await copyBooks(memoryStore(src), memoryStore(dst), [
    "moby-dick",
    "walden",
  ]);
  assertEquals(got, { copied: ["walden"], skipped: ["moby-dick"] });
  assertEquals(text(dst.get("moby-dick/manuscript.md")), "ours\n");
  assertEquals(text(dst.get("walden/manuscript.md")), "walden\n");
  assertEquals(text(dst.get("walden/images/a.png")), "png");
});

Deno.test("copyBooks: a copy that fails partway leaves no manuscript.md, so a retry takes it", async () => {
  const src = new Map([
    ["walden/manuscript.md", bytes("walden\n")],
    ["walden/images/a.png", bytes("png")],
  ]);
  const dst = new Map<string, Uint8Array>();
  const to = memoryStore(dst);
  const failing = {
    ...to,
    create: (path: string, data: string | Uint8Array) =>
      path.endsWith("a.png")
        ? Promise.reject(new Error("disk full"))
        : to.create(path, data),
  };
  await assertRejects(() => copyBooks(memoryStore(src), failing, ["walden"]));
  assertEquals(dst.has("walden/manuscript.md"), false);
  const got = await copyBooks(memoryStore(src), to, ["walden"]);
  assertEquals(got, { copied: ["walden"], skipped: [] });
  assertEquals(text(dst.get("walden/images/a.png")), "png");
});
