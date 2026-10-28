// Waiting in tests without a clock (architecture → references/dev-workflow.md,
// "Waiting without a clock"). The only sleeps tests may use without a
// `// clock:` reason; clock_test.ts holds every other one to that.
import type { Page } from "playwright";

/** Polls until `ok`, checking first. The deadline only catches a real hang,
 * so it is long: a slow CI runner must never reach it on a passing run. */
export async function until(
  ok: () => boolean | Promise<boolean>,
  what = "the condition",
  timeoutMs = 30_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Retries `check` until it stops throwing, then returns its value; past the
 * deadline its last error is the failure. Playwright Test's retrying
 * `expect` for plain asserts: a read of state that an action changes later
 * (`await eventually(async () => assertEquals(await x.count(), 0))`).
 * Never for "stays": a check that already holds passes at once. */
export async function eventually<T>(
  check: () => T | Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Waits until the preview is laid out with nothing pending — no render
 * under way, no edit waiting for one — and everything that reads the pages
 * (page turns, the indicator) has caught up. Returns the layout's count;
 * pass the count from before an edit to wait for the layout after it. */
export async function laidOut(
  page: Page,
  after = 0,
  timeoutMs = 60_000,
): Promise<number> {
  const done = await page.waitForFunction(
    (after) => {
      const el = document.getElementById("preview");
      const n = Number(el?.dataset.layouts ?? 0);
      const idle = el && !("rendering" in el.dataset) &&
        !("stale" in el.dataset);
      return idle && n > after ? n : 0;
    },
    after,
    // An interval, not animation frames: a hidden tab never gets those.
    { timeout: timeoutMs, polling: 50 },
  );
  return await done.jsonValue();
}

/** A pause before asserting that something did NOT happen (no second push,
 * no file written). Slowness only makes these pass more easily; never use it
 * to wait for something that should happen — that is `until`. */
export function quietFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
