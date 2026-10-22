// Shared Chrome detection for tests: actually launch it, so a stale install
// path or a missing runner never reads as "available", and a hung launch
// gives up after 15s. Cached per process.
import { chromium } from "playwright";

// `SKIP_CHROME=1` (the `test:fast` task, pre-commit) skips the browser tests outright.
export const hasChrome: boolean = Deno.env.get("SKIP_CHROME")
  ? false
  : await (async () => {
    try {
      const browser = await chromium.launch({
        channel: "chrome",
        timeout: 15_000,
      });
      await browser.close();
      return true;
    } catch {
      return false;
    }
  })();
