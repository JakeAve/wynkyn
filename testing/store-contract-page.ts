// testing/store-contract-page.ts — bundled for the browser by
// web/src/store-browser_test.ts: the store contract's cases, run in a page
// against handleStore over the origin-private file system.
import { contractCases } from "../server/store-contract.ts";
import { handleStore } from "../web/src/fs-store.ts";

declare global {
  var contract: {
    run(name: string): Promise<string | null>;
  };
}

globalThis.contract = {
  /** Runs one case over a fresh subfolder; null on a pass, else the error. */
  async run(name) {
    const c = contractCases.find((c) => c.name === name)!;
    const opfs = await navigator.storage.getDirectory();
    const dir = crypto.randomUUID();
    try {
      await c.run(handleStore(
        await opfs.getDirectoryHandle(dir, {
          create: true,
        }),
      ));
      return null;
    } catch (e) {
      return e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    } finally {
      await opfs.removeEntry(dir, { recursive: true });
    }
  },
};
