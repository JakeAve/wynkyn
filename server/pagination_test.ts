// server/pagination_test.ts — the corpus books through the real export HTML in
// Chrome: the page map settles fast, reports nothing, and matches a golden
// digest; and laid out through segments and assembled (spec: segmented layout)
// they are the whole-flow render page for page, which the digest can't see.
// Re-run on a Paged.js upgrade. `UPDATE_GOLDEN=1 deno test -A
// server/pagination_test.ts` rewrites the golden files.
//
// A corpus layout takes seconds, so each (book, variant, flow) is laid out once
// per run and every test reads off it.
import { assert, assertEquals } from "@std/assert";
import { buildBook } from "./pipeline.ts";
import { toHtml } from "./export-html.ts";
import type { PageProblem } from "../renderer/page-map-types.ts";
import type { Metadata } from "../metadata/types.ts";
import { parseMetadataText } from "../metadata/loader.ts";
import { chromeTest, newPage } from "../testing/chrome.ts";

const ROOT = new URL("../testdata/", import.meta.url).pathname;
const BOOKS = ["common-sense", "great-gatsby"];
// Pages warned (folios.js). Common Sense's first chapter title is too long for
// a running head until short running titles exist; Gatsby's mansion plate has
// no image in the corpus, so it prints its placeholder.
const WARNED: Record<string, number[]> = {
  "common-sense": [14, 16, 18],
  "great-gatsby": [17],
};

const VARIANTS = {
  default: null,
  // Paged.js drops a `break-before: page` where the page name already changes,
  // and base.css's `.zone-*` page rules come first, so with plain page breaks
  // a zone-start bug stays hidden — even one re-declared in metadata, since
  // Paged.js applies rules by where their selector first appears. It only
  // drops `page`, though: chapters that open recto keep their break and
  // strand anything that opens the zone ahead of them (e.g. a zone wrapper).
  // The copyright page fills its text block with flex, so space above it comes
  // out of the page instead of pushing the page onto a second one.
  zones: (m: Metadata): Metadata => {
    const elements = { ...m.elements };
    for (const key of ["chapter", "part", "matter"]) {
      elements[key] = { ...elements[key], "break-before": "right" };
    }
    elements.copyright = { ...elements.copyright, "margin-top": "12pt" };
    return { ...m, elements };
  },
  // A chapter in a part is laid out inside a `.part` wrapper marked
  // data-split-from (renderer/render.ts), standing in for the part's continued
  // fragment in one flow: styles on the part and on its chapters (`.part >
  // .chapter`), and Paged.js's resets for split fragments (margin/padding-top,
  // text-indent), must reach it the same. The drop cap opening each part's
  // first chapter is the likeliest to differ.
  "styled-parts": (m: Metadata): Metadata => ({
    ...m,
    elements: {
      ...m.elements,
      part: {
        ...m.elements?.part,
        "margin-top": "18pt",
        "padding-top": "12pt",
        "border-top": "2pt solid #8b1a1a",
        "background-color": "#f6efe3",
        "text-indent": "3em",
        chapter: {
          "margin-top": "24pt",
          "padding-top": "6pt",
          "text-indent": "1em",
          dropcap: { "font-size": "4.2em", color: "#8b1a1a" },
        },
      },
    },
  }),
  "overfull-title": (m: Metadata): Metadata => ({
    ...m,
    elements: {
      ...m.elements,
      "title-page": {
        ...m.elements?.["title-page"],
        title: { "font-size": "120pt" },
      },
    },
  }),
};
type Variant = keyof typeof VARIANTS;

interface Report {
  problems: PageProblem[];
  passes: number;
  digest: {
    zones: Record<string, [number, number]>;
    anchors: Record<string, string>;
    blanks: number[];
  };
}

interface PageShape {
  classes: string;
  id: string;
  number: string;
  folio: string;
  boxes: string;
  text: string;
  styles: string;
}

interface Layout {
  report: Report;
  layout: string;
  segments: number;
  ms: number;
  pages: PageShape[];
  /** A running head's face and figures, the text's figures and face; then the
   * head's and the text's figures again inside an app body. */
  fonts: string[];
}

const layouts = new Map<string, Promise<Layout>>();

function laidOutBook(
  book: string,
  variant: Variant = "default",
  whole = false,
): Promise<Layout> {
  const key = `${book} ${variant} ${whole ? "whole" : "segments"}`;
  let p = layouts.get(key);
  if (!p) layouts.set(key, p = layOut(book, variant, whole));
  return p;
}

// Inline `grid-template-columns` on margin rows is left out of a page's shape:
// assembly redoes it on pages that changed side and doesn't always write what
// Paged.js measured (25 of Gatsby's pages), but base.css's `!important` row
// templates override both, so the printed page is the same.
async function layOut(
  book: string,
  variant: Variant,
  whole: boolean,
): Promise<Layout> {
  const path = `${ROOT}${book}/metadata.json`;
  const restyle = VARIANTS[variant];
  const built = await buildBook(ROOT, book, {
    imageUrlPrefix: `file://${ROOT}${book}/images`,
    metadata: restyle
      ? restyle(parseMetadataText(await Deno.readTextFile(path), path).meta)
      : undefined,
  });
  const file = await Deno.makeTempFile({ suffix: ".html" });
  const page = await newPage();
  try {
    await Deno.writeTextFile(file, toHtml(built, { whole }));
    const start = performance.now();
    await page.goto(`file://${file}`);
    await page.waitForSelector("html[data-paged]", { timeout: 540_000 });
    const ms = Math.round(performance.now() - start);
    const reportText = (await page.getAttribute("html", "data-paged-report"))!;
    assertEquals(
      await page.getAttribute("html", "data-paged"),
      "done",
      `${book} (${variant}): ${reportText}`,
    );
    const pages = await page.evaluate(() => {
      const style = (e: Element | null | undefined, pseudo?: string) =>
        e ? getComputedStyle(e, pseudo) : undefined;
      const box = (s = style(null)) =>
        s ? `${s.borderTop} ${s.backgroundColor} ${s.padding} ${s.margin}` : "";
      const letter = (s = style(null)) => s ? `${s.fontSize} ${s.color}` : "";
      return [...document.querySelectorAll<HTMLElement>(".pagedjs_page")].map((
        p,
      ) => {
        const area = p.querySelector(".pagedjs_area");
        const ch = area?.querySelector(".chapter");
        return {
          classes: [...p.classList].sort().join(" "),
          id: p.id,
          number: p.dataset.pageNumber ?? "",
          folio: p.dataset.folio ?? "",
          boxes: [...p.querySelectorAll(".pagedjs_margin.hasContent")]
            .map((b) =>
              [...b.classList].find((c) => c.startsWith("pagedjs_margin-"))
            ).join(" "),
          text: area?.textContent ?? "",
          // The box of each part on the page, real or a segment's wrapper, and
          // of its first chapter, with that chapter's drop cap.
          styles: [
            ...[...area?.querySelectorAll(".part") ?? []].map((e) =>
              box(style(e))
            ),
            box(style(ch)),
            letter(style(ch?.querySelector(".dropcap"))),
            letter(style(ch?.querySelector("p"), "::first-letter")),
          ].join(" | "),
        };
      });
    });
    // Last: it restyles the body.
    const fonts = await page.evaluate(() => {
      const after = (el: Element | null) => {
        if (!el) return "";
        const s = getComputedStyle(el, "::after");
        return `${s.fontFamily} ${s.fontVariantNumeric}`;
      };
      const head = document.querySelector(
        ".pagedjs_margin-top-right.hasContent .pagedjs_margin-content",
      );
      const text = getComputedStyle(document.querySelector(".bml")!);
      const was = [after(head), text.fontVariantNumeric, text.fontFamily];
      // As web/app.css's body does around the preview.
      document.body.style.font = "15px/1.45 sans-serif";
      document.body.style.fontVariantNumeric = "lining-nums";
      return [...was, after(head), text.fontVariantNumeric];
    });
    return {
      report: JSON.parse(reportText),
      layout: (await page.getAttribute("html", "data-paged-layout"))!,
      segments: built.segments.length,
      ms,
      pages,
      fonts,
    };
  } finally {
    await page.context().close();
    await Deno.remove(file).catch(() => {});
  }
}

// Regression for the zone-wrapper change: no page is stranded (the page map
// reports those as problems) and a zone never opens on an empty page.
function assertZonesOpenOnContent(label: string, { report, pages }: Layout) {
  assertEquals(
    report.problems.filter((p) => !p.warn),
    [],
    `${label}: page map problems`,
  );
  for (const [zone, [first]] of Object.entries(report.digest.zones)) {
    assert(
      !report.digest.blanks.includes(first),
      `${label}: ${zone} starts on blank page ${first}`,
    );
    assert(
      pages[first - 1]?.text.trim(),
      `${label}: ${zone} starts on an empty page ${first}`,
    );
  }
}

async function assertParity(book: string, variant: Variant): Promise<void> {
  const segmented = await laidOutBook(book, variant);
  const whole = await laidOutBook(book, variant, true);
  console.log(
    `${book}: cold render, whole flow ${whole.ms} ms, ` +
      `${segmented.segments} segments ${segmented.ms} ms`,
  );
  assertEquals(whole.layout, "whole");
  assertEquals(segmented.layout, "segments", "fell back to the whole flow");
  assertEquals(segmented.pages.length, whole.pages.length, "page count");
  whole.pages.forEach((w, i) =>
    assertEquals(segmented.pages[i], w, `${book}: page ${i + 1}`)
  );
}

for (const book of BOOKS) {
  chromeTest({
    name: `page map: ${book} matches its golden digest`,
    fn: async () => {
      const result = await laidOutBook(book);
      const { report } = result;
      assertZonesOpenOnContent(book, result);
      assertEquals(
        report.problems.filter((p) => p.warn).map((p) => p.page),
        WARNED[book] ?? [],
        `${book}: warnings`,
      );
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

  chromeTest({
    name: `page map: ${book} with recto breaks and space above the copyright`,
    fn: async () =>
      assertZonesOpenOnContent(
        `${book} (zones)`,
        await laidOutBook(book, "zones"),
      ),
  });
}

// The pages are paper, not the app: an editor <body>'s UI face never reaches a
// running head or the text (the preview set heads in the UI font).
chromeTest({
  name: "page map: great-gatsby in an app body keeps the book's faces",
  fn: async () => {
    const { fonts } = await laidOutBook("great-gatsby", "zones");
    const [head, figures, bodyFace, headInApp, figuresInApp] = fonts;
    assert(
      head!.startsWith(bodyFace!),
      `a head sets in the body face: ${head}`,
    );
    assertEquals(headInApp, head, "a running head ignores the app's font");
    assertEquals(figuresInApp, figures, "the text ignores the app's figures");
  },
});

// Common Sense's parity is on its styled parts.
chromeTest({
  name: "segments: great-gatsby assembles to the whole-flow render",
  fn: () => assertParity("great-gatsby", "default"),
});

chromeTest({
  name: "segments: common-sense with styled parts, chapters and drop caps",
  fn: () => assertParity("common-sense", "styled-parts"),
});

chromeTest({
  name: "segments: great-gatsby's overfull title page is cut, nothing moves",
  fn: async () => {
    await assertParity("great-gatsby", "overfull-title");
    const { report } = await laidOutBook("great-gatsby", "overfull-title");
    const { report: fits } = await laidOutBook("great-gatsby");
    assertEquals(
      report.problems.filter((p) => /runs past one page/.test(p.message))
        .map((p) => p.page),
      [3],
    );
    assertEquals(report.digest, fits.digest);
  },
});
