// One Chrome per test process, kept across its tests: a test opens a page in
// its own context (its own storage) instead of launching a browser, which
// costs a second or more on CI.
import { type Browser, chromium, type Page } from "playwright";

const launch = () => chromium.launch({ channel: "chrome", timeout: 15_000 });

// Detection launches for real, so a stale install path or a missing runner
// never reads as "available". `SKIP_CHROME=1` (the `test:fast` task,
// pre-commit) skips the browser tests outright.
export const hasChrome: boolean = Deno.env.get("SKIP_CHROME")
  ? false
  : await launch().then(
    async (b) => {
      await b.close();
      return true;
    },
    (e) => {
      // On CI a missing Chrome must fail the run, not quietly skip every
      // browser test and go green.
      if (Deno.env.get("CI")) throw e;
      return false;
    },
  );

// Launched inside the first test that asks, never while modules load: a
// browser launched at import hung the first newContext now and then, with
// Chrome's answer left unread on the pipe.
let shared: Promise<Browser> | undefined;
const open = new Set<{ close(): Promise<void> }>();

/** A page in a fresh context of the shared Chrome, closed when its
 * `chromeTest` ends. */
export async function newPage(
  opts?: Parameters<Browser["newContext"]>[0],
): Promise<Page> {
  const context = await (await (shared ??= launch())).newContext(opts);
  open.add(context);
  return await context.newPage();
}

/** `Deno.test` on the shared Chrome. Deno's op and resource sanitizers are
 * off: they would count Chrome's pipe, open across tests, as this test's
 * leak. */
export function chromeTest(
  t: {
    name: string;
    ignore?: boolean;
    fn: (t: Deno.TestContext) => Promise<void>;
  },
): void {
  Deno.test({
    name: t.name,
    ignore: !hasChrome || t.ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn(ctx) {
      try {
        await t.fn(ctx);
      } finally {
        for (const c of open) await c.close();
        open.clear();
      }
    },
  });
}
