// One Chrome per test process, kept across its tests: a test opens a page in
// its own context (its own storage) instead of launching a browser, which
// costs a second or more on CI.
import { type Browser, chromium, type Page } from "playwright";

const launch = () => chromium.launch({ channel: "chrome", timeout: 15_000 });

// Playwright leaves newContext, evaluate and close without a deadline, and CI
// has hung on each; a hang must fail its own test by name, not run the job
// out. TEST_LIMIT is ten times the slowest test on CI (14 s).
const TEST_LIMIT = 150_000;
const STEP_LIMIT = 30_000;

function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}: no answer after ${ms / 1000} s`)),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// Detection launches for real, so a stale install path or a missing runner
// never reads as "available". `SKIP_CHROME=1` (the `test:fast` task,
// pre-commit) skips the browser tests outright.
export const hasChrome: boolean = Deno.env.get("SKIP_CHROME")
  ? false
  : await launch().then(
    async (b) => {
      await within(STEP_LIMIT, "closing the probe Chrome", b.close());
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
  const browser = await (shared ??= launch());
  // A browser that stops answering is relaunched for the next test.
  const context = await within(
    STEP_LIMIT,
    "a new browser context",
    browser.newContext(opts),
  ).catch((e) => {
    if (shared) void browser.close().catch(() => {});
    shared = undefined;
    throw e;
  });
  open.add(context);
  return await within(STEP_LIMIT, "a new page", context.newPage());
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
        await within(TEST_LIMIT, t.name, t.fn(ctx));
      } finally {
        for (const c of open) {
          await within(STEP_LIMIT, "closing a context", c.close()).catch(
            () => {},
          );
        }
        open.clear();
      }
    },
  });
}
