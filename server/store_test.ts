// server/store_test.ts — the store contract over a folder and over memory.
import { assertEquals } from "@std/assert";
import { diskStore } from "./store.ts";
import { storeContract } from "./store-contract.ts";
import { memoryStore } from "../testing/memory-store.ts";

storeContract("diskStore", async () => {
  const root = await Deno.makeTempDir();
  return {
    store: diskStore(root),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
});

storeContract(
  "memoryStore",
  () =>
    Promise.resolve({ store: memoryStore(), cleanup: () => Promise.resolve() }),
);

Deno.test("memoryStore: two stores over one Map share files", async () => {
  const files = new Map<string, Uint8Array>();
  await memoryStore(files).create("a/manuscript.md", "x");
  assertEquals(await memoryStore(files).readText("a/manuscript.md"), "x");
});
