// Shared Chrome detection for tests: actually launch it, so a stale install
// path or a missing runner never reads as "available". Cached per process.
import { chromium } from "playwright";

export const hasChrome: boolean = await (async () => {
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();
