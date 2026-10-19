// server/pdf.ts — Paged.js-paginated HTML → PDF via headless Google Chrome.
import { type Browser, chromium } from "playwright";
import type { PageProblem, Seed } from "../renderer/page-map-types.ts";

export interface RenderedPdf {
  pdf: Uint8Array;
  problems: PageProblem[]; // from the page map checks (spec §5.4)
  passes: number; // renders it took to reach a fixed point
  seed: Seed; // the folios it settled on, to start the next render from
}

export async function renderPdf(html: string): Promise<RenderedPdf> {
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
    // Set by the driver in toHtml, after up to 3 passes.
    await page.waitForSelector("html[data-paged]", { timeout: 540_000 });
    const report = JSON.parse(
      await page.getAttribute("html", "data-paged-report") ?? "{}",
    ) as {
      problems?: PageProblem[];
      passes?: number;
      seed?: Seed;
      fatal?: string;
    };
    // Not a pagination problem: there is nothing to export, --force or not.
    if (report.fatal) {
      throw new Error(`Paged.js render failed: ${report.fatal}`);
    }
    return {
      pdf: new Uint8Array(
        await page.pdf({ preferCSSPageSize: true, printBackground: true }),
      ),
      problems: report.problems ?? [],
      passes: report.passes ?? 0,
      seed: report.seed ?? {},
    };
  } finally {
    await browser?.close();
    await Deno.remove(file).catch(() => {});
  }
}
