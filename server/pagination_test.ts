// server/pagination_test.ts — the corpus books through the real export HTML in
// Chrome: the page map settles fast, reports nothing, and matches a golden
// digest. `UPDATE_GOLDEN=1 deno task test` rewrites the golden files.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { buildBook, toHtml } from "./pipeline.ts";
import type { PageProblem } from "../renderer/page-map-types.ts";
import type { Metadata } from "../metadata/types.ts";
import { hasChrome } from "../testing/chrome.ts";

const ROOT = new URL("../testdata/", import.meta.url).pathname;
const BOOKS = ["common-sense", "great-gatsby"];

interface Digest {
  zones: Record<string, [number, number]>;
  anchors: Record<string, string>;
  blanks: number[];
}

interface Report {
  problems: PageProblem[];
  passes: number;
  digest: Digest;
}

async function paginate(
  root: string,
  book: string,
): Promise<{ report: Report; firstPageText: Record<string, string> }> {
  const built = await buildBook(root, book, {
    imageUrlPrefix: `file://${root}${book}/images`,
  });
  const file = await Deno.makeTempFile({ suffix: ".html" });
  await Deno.writeTextFile(file, toHtml(built));
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${file}`);
    await page.waitForSelector("html[data-paged]", { timeout: 540_000 });
    const report: Report & { fatal?: string } = JSON.parse(
      (await page.getAttribute("html", "data-paged-report"))!,
    );
    // A driver failure has no digest; show its error, not a TypeError.
    if (report.fatal) {
      throw new Error(`${book}: render failed: ${report.fatal}`);
    }
    const firsts = Object.fromEntries(
      Object.entries(report.digest.zones).map(([z, [first]]) => [z, first]),
    );
    const firstPageText = await page.evaluate((firsts) => {
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
    return { report, firstPageText };
  } finally {
    await browser.close();
    await Deno.remove(file).catch(() => {});
  }
}

// Regression for the zone-wrapper change: no page is stranded (the page map
// reports those as problems) and a zone never opens on an empty page.
function assertZonesOpenOnContent(
  label: string,
  { report, firstPageText }: Awaited<ReturnType<typeof paginate>>,
) {
  assertEquals(report.problems, [], `${label}: page map problems`);
  for (const [zone, [first]] of Object.entries(report.digest.zones)) {
    assert(
      !report.digest.blanks.includes(first),
      `${label}: ${zone} starts on blank page ${first}`,
    );
    assert(
      firstPageText[zone] !== "",
      `${label}: ${zone} starts on an empty page ${first}`,
    );
  }
}

for (const book of BOOKS) {
  Deno.test({
    name: `page map: ${book} matches its golden digest`,
    ignore: !hasChrome,
    fn: async () => {
      const result = await paginate(ROOT, book);
      const { report } = result;
      assertZonesOpenOnContent(book, result);
      assert(report.passes <= 2, `${book}: took ${report.passes} passes`);

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

  // Paged.js drops a `break-before: page` where the page name already changes,
  // and base.css's `.zone-*` page rules come first, so with plain page breaks
  // a zone-start bug stays hidden — even one re-declared in metadata, since
  // Paged.js applies rules by where their selector first appears. It only
  // drops `page`, though: chapters that open recto keep their break and
  // strand anything that opens the zone ahead of them (e.g. a zone wrapper).
  Deno.test({
    name: `page map: ${book} with recto chapter/part/matter breaks in metadata`,
    ignore: !hasChrome,
    fn: async () => {
      const root = await Deno.makeTempDir();
      try {
        await Deno.mkdir(`${root}/${book}`);
        await Deno.copyFile(
          `${ROOT}${book}/manuscript.md`,
          `${root}/${book}/manuscript.md`,
        );
        const meta: Metadata = JSON.parse(
          await Deno.readTextFile(`${ROOT}${book}/metadata.json`),
        );
        const elements = meta.elements ?? {};
        for (const key of ["chapter", "part", "matter"]) {
          elements[key] = { ...elements[key], "break-before": "right" };
        }
        meta.elements = elements;
        await Deno.writeTextFile(
          `${root}/${book}/metadata.json`,
          JSON.stringify(meta),
        );
        assertZonesOpenOnContent(
          `${book} (recto breaks)`,
          await paginate(`${root}/`, book),
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  });
}
