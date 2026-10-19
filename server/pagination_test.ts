// server/pagination_test.ts — the corpus books through the real export HTML in
// Chrome: the page map settles fast, reports nothing, and matches a golden
// digest. `UPDATE_GOLDEN=1 deno task test` rewrites the golden files.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { buildBook, toHtml } from "./pipeline.ts";
import type { PageProblem } from "./pdf.ts";

const hasChrome = await Deno.stat("/Applications/Google Chrome.app").then(
  () => true,
  () => false,
);

const ROOT = new URL("../testdata/", import.meta.url).pathname;

interface Digest {
  zones: Record<string, [number, number]>;
  anchors: Record<string, string>;
  blanks: number[];
}

for (const book of ["common-sense", "great-gatsby"]) {
  Deno.test({
    name: `page map: ${book} matches its golden digest`,
    ignore: !hasChrome,
    fn: async () => {
      const built = await buildBook(ROOT, book, {
        imageUrlPrefix: `file://${ROOT}${book}/images`,
      });
      const file = await Deno.makeTempFile({ suffix: ".html" });
      await Deno.writeTextFile(file, toHtml(built));
      const browser = await chromium.launch({ channel: "chrome" });
      let report: { problems: PageProblem[]; passes: number; digest: Digest };
      let firstPageText: Record<string, string> = {};
      try {
        const page = await browser.newPage();
        await page.goto(`file://${file}`);
        await page.waitForSelector("html[data-paged]", { timeout: 540_000 });
        report = JSON.parse(
          (await page.getAttribute("html", "data-paged-report"))!,
        );
        const firsts = Object.fromEntries(
          Object.entries(report.digest.zones).map(([z, [first]]) => [z, first]),
        );
        firstPageText = await page.evaluate((firsts) => {
          const pages = document.querySelectorAll(".pagedjs_page");
          return Object.fromEntries(
            Object.entries(firsts).map(([z, n]) => [
              z,
              // the content area only: margin boxes carry folios and running heads
              pages[n - 1]?.querySelector(".pagedjs_page_content")
                ?.textContent?.trim() ?? "",
            ]),
          );
        }, firsts);
      } finally {
        await browser.close();
        await Deno.remove(file).catch(() => {});
      }

      assertEquals(report.problems, [], `${book}: page map problems`);
      assert(report.passes <= 2, `${book}: took ${report.passes} passes`);
      // Regression for the zone-wrapper change: a zone never opens on an empty page.
      for (const [zone, [first]] of Object.entries(report.digest.zones)) {
        assert(
          !report.digest.blanks.includes(first),
          `${book}: ${zone} starts on blank page ${first}`,
        );
        assert(
          firstPageText[zone] !== "",
          `${book}: ${zone} starts on an empty page ${first}`,
        );
      }

      const golden = `${ROOT}${book}/page-map.json`;
      if (Deno.env.get("UPDATE_GOLDEN")) {
        await Deno.writeTextFile(
          golden,
          JSON.stringify(report.digest, null, 2) + "\n",
        );
        return;
      }
      assertEquals(
        report.digest,
        JSON.parse(await Deno.readTextFile(golden)),
        `${book}: digest differs from ${golden}\nactual:\n${
          JSON.stringify(report.digest, null, 2)
        }`,
      );
    },
  });
}
