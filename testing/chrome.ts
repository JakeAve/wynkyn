// One Chrome per test process, launched here and kept: a test opens a page in
// its own context (its own storage) instead of launching a browser, which
// costs a second or more on CI. The launch is the detection too, so a stale
// install path or a missing runner never reads as "available".
import { type Browser, chromium, type Page } from "playwright";

// `SKIP_CHROME=1` (the `test:fast` task, pre-commit) skips the browser tests outright.
export const chrome: Browser | null = Deno.env.get("SKIP_CHROME")
  ? null
  : await chromium.launch({ channel: "chrome", timeout: 15_000 }).catch(
    (e) => {
      // On CI a missing Chrome must fail the run, not quietly skip every
      // browser test and go green.
      if (Deno.env.get("CI")) throw e;
      return null;
    },
  );
export const hasChrome = chrome !== null;

const open = new Set<{ close(): Promise<void> }>();

/** A page in a fresh context of the shared Chrome, closed when its
 * `chromeTest` ends. */
export async function newPage(
  opts?: Parameters<Browser["newContext"]>[0],
): Promise<Page> {
  const context = await chrome!.newContext(opts);
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
