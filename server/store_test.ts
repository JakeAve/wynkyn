// server/store_test.ts — the store contract over a folder and over memory.
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
