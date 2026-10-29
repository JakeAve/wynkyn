// web/src/store-browser_test.ts — the store contract (server/store-contract.ts)
// against handleStore in Chrome, over the browser's private storage: the same
// cases diskStore and the memory store pass, one step each.
import { chromeTest, newPage } from "../../testing/chrome.ts";
import { contractCases } from "../../server/store-contract.ts";

type Contract = { run(name: string): Promise<string | null> };
const ENTRY = new URL("../../testing/store-contract-page.ts", import.meta.url);

chromeTest({
  name: "handleStore over OPFS passes the store contract",
  async fn(t) {
    const tmp = await Deno.makeTempDir();
    const out = `${tmp}/contract.js`;
    const built = await new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--platform",
        "browser",
        "--output",
        out,
        ENTRY.pathname,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!built.success) throw new Error(new TextDecoder().decode(built.stderr));
    const js = await Deno.readFile(out);
    // A blank page on localhost: the private file system needs a secure context.
    const server = Deno.serve(
      { port: 0, onListen() {} },
      (req) =>
        new URL(req.url).pathname === "/contract.js"
          ? new Response(js, { headers: { "content-type": "text/javascript" } })
          : new Response(
            '<!doctype html><script type="module" src="/contract.js"></script>',
            { headers: { "content-type": "text/html" } },
          ),
    );
    try {
      const page = await newPage();
      await page.goto(`http://localhost:${server.addr.port}/`);
      await page.waitForFunction(() => "contract" in globalThis);
      for (const c of contractCases) {
        await t.step(c.name, async () => {
          const err = await page.evaluate(
            (n) =>
              (globalThis as unknown as { contract: Contract }).contract.run(n),
            c.name,
          );
          if (err) throw new Error(err);
        });
      }
    } finally {
      await server.shutdown();
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
