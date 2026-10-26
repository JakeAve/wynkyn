// server/store-contract.ts — what every BookStore must do, as cases any store
// can be run through: diskStore and the memory store here (store_test.ts),
// handleStore in the browser. contractCases stays free of Deno APIs so a
// browser bundle can import it; only storeContract touches Deno.
import { assert, assertEquals } from "@std/assert";
import type { BookStore } from "./store.ts";

export interface ContractCase {
  name: string;
  run(store: BookStore): Promise<void>;
}

// Polls: a folder's watch reports from fs events, a beat after the write.
async function until(what: string, ok: () => boolean): Promise<void> {
  for (const end = Date.now() + 5000; !ok(); await pause(20)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const contractCases: ContractCase[] = [
  {
    name: "read and write round trip",
    async run(store) {
      assert(await store.create("a/manuscript.md", "one"));
      await store.write("a/manuscript.md", "two");
      assertEquals(await store.readText("a/manuscript.md"), "two");
      assertEquals(
        await store.read("a/manuscript.md"),
        new TextEncoder().encode("two"),
      );
      await store.write("a/cover.bin", new Uint8Array([1, 2, 3]));
      assertEquals(await store.read("a/cover.bin"), new Uint8Array([1, 2, 3]));
      assert(await store.exists("a/manuscript.md"));
      assertEquals(await store.read("a/missing.md"), null);
      assertEquals(await store.readText("b/missing.md"), null);
      assert(!await store.exists("a/missing.md"));
    },
  },
  {
    name: "create refuses an existing file",
    async run(store) {
      assert(await store.create("a/images/x.png", "first"));
      assert(!await store.create("a/images/x.png", "second"));
      assertEquals(await store.readText("a/images/x.png"), "first");
    },
  },
  {
    name: "rename leaves one file, at its new name",
    async run(store) {
      assert(await store.create("a/editions/x.json", "{}"));
      assert(await store.rename("a/editions/x.json", "a/editions/y.json"));
      assertEquals(await store.listDir("a/editions"), ["y.json"]);
      assertEquals(await store.readText("a/editions/y.json"), "{}");
      assert(!await store.rename("a/editions/x.json", "a/editions/z.json"));
    },
  },
  {
    name: "remove",
    async run(store) {
      assert(await store.create("a/editions/x.json", "{}"));
      assert(await store.remove("a/editions/x.json"));
      assert(!await store.exists("a/editions/x.json"));
      assert(!await store.remove("a/editions/x.json"));
    },
  },
  {
    name: "listDir names files only, sorted",
    async run(store) {
      await store.create("a/b.txt", "");
      await store.create("a/a.txt", "");
      await store.create("a/sub/c.txt", "");
      assertEquals(await store.listDir("a"), ["a.txt", "b.txt"]);
      assertEquals(await store.listDir("nope"), []);
    },
  },
  {
    name: "list names books with a manuscript, sorted",
    async run(store) {
      await store.create("b/manuscript.md", "");
      await store.create("a/manuscript.md", "");
      await store.create("c/metadata.json", "");
      assertEquals(await store.list(), ["a", "b"]);
    },
  },
  {
    name: "watch reports the store's own writes",
    async run(store) {
      const seen = new Set<string>();
      const stop = store.watch((paths) => paths.forEach((p) => seen.add(p)));
      try {
        // A fresh fs watch can miss its first events: write until one lands.
        await store.create("a/manuscript.md", "");
        // Spaced wider than a debounced watch's quiet period, or it never fires.
        for (let i = 0; !seen.has("a/manuscript.md"); i++) {
          if (i === 15) throw new Error("the watch never started");
          await pause(300);
          await store.write("a/manuscript.md", String(i));
        }
        await store.create("a/created.md", "");
        await store.create("a/written.md", "");
        await store.write("a/written.md", "x");
        await store.create("a/from.md", "");
        await store.rename("a/from.md", "a/to.md");
        await store.create("a/removed.md", "");
        await store.remove("a/removed.md");
        const want = ["created", "written", "from", "to", "removed"]
          .map((n) => `a/${n}.md`);
        await until(want.join(", "), () => want.every((p) => seen.has(p)));
      } finally {
        stop();
      }
    },
  },
];

/** Registers every case as a Deno test, each on a fresh store from `make`. */
export function storeContract(
  name: string,
  make: () => Promise<{ store: BookStore; cleanup(): Promise<void> }>,
): void {
  for (const c of contractCases) {
    Deno.test(`${name}: ${c.name}`, async () => {
      const { store, cleanup } = await make();
      try {
        await c.run(store);
      } finally {
        await cleanup();
      }
    });
  }
}
