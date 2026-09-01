// server/pdf.ts — Paged.js-paginated HTML → PDF via headless Google Chrome.
import { type Browser, chromium } from "playwright";

export async function renderPdf(html: string): Promise<Uint8Array> {
  const file = await Deno.makeTempFile({ suffix: ".html" });
  await Deno.writeTextFile(file, html);
  let browser: Browser | undefined;
  try {
    try {
      browser = await chromium.launch({ channel: "chrome" });
    } catch (e) {
      throw new Error(
        `could not launch Google Chrome (install it from google.com/chrome): ${
          (e as Error).message.split("\n")[0]
        }`,
      );
    }
    const page = await browser.newPage();
    await page.goto(`file://${file}`);
    await page.waitForSelector("html[data-paged=done]", { timeout: 180_000 }); // set by PagedConfig.after in toHtml
    return new Uint8Array(
      await page.pdf({ preferCSSPageSize: true, printBackground: true }),
    );
  } finally {
    await browser?.close();
    await Deno.remove(file).catch(() => {});
  }
}
