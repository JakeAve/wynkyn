// Waiting in tests without a clock (architecture → references/dev-workflow.md,
// "Waiting without a clock"). The only sleeps tests may use without a
// `// clock:` reason; clock_test.ts holds every other one to that.

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

/** A pause before asserting that something did NOT happen (no second push,
 * no file written). Slowness only makes these pass more easily; never use it
 * to wait for something that should happen — that is `until`. */
export function quietFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
