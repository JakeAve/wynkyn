import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright";
import { parse } from "../parser/parser.ts";
import {
  generateDomCSS,
  generatePagedCSS,
  pageNumberingConfig,
} from "../metadata/css-generator.ts";
import type { Metadata } from "../metadata/types.ts";
import { PAGED_JS } from "../server/pipeline.ts";
import { render } from "./render.ts";
import "./folios.js";
import { hasChrome } from "../testing/chrome.ts";

// deno-lint-ignore no-explicit-any
const { anchorFolios } = (globalThis as any).BookPageMap;

const prose = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8)
      }${i}`,
  ).join("\n\n");
const manuscript = [
  "{matter: title-page}",
  "{title}",
  "The Book",
  "{matter: toc}",
  "{title}",
  "Contents",
  "{matter: preface}",
  "{title}",
  "Preface",
  "",
  prose(6),
  "{chapter: one}",
  "{title}",
  "Chapter One",
  "",
  prose(4),
  "{illustration: plate | placement: full-page}",
  "A plate",
  "",
  prose(4),
  "{chapter: two}",
  "{title}",
  "Chapter Two",
  "",
  "As shown in {ref: one}, it goes on.",
  "",
  prose(8),
].join("\n");
const metadata: Metadata = {
  page: {
    size: "4in 6in",
    margins: {
      top: "0.5in",
      bottom: "0.6in",
      inside: "0.5in",
      outside: "0.5in",
    },
  },
  numbering: {
    pages: {
      "front-matter": { style: "roman-lower", show: true },
      body: { style: "arabic", show: true },
    },
  },
};
const baseCss = await Deno.readTextFile(new URL("./base.css", import.meta.url));
// What the pipeline hands Paged.js for a manuscript + metadata.
function build(manuscript: string, metadata: Metadata) {
  return {
    html: render(parse(manuscript), {
      numbering: metadata.numbering,
      notes: metadata.notes,
    }),
    css: [
      baseCss,
      generateDomCSS(metadata),
      generatePagedCSS(metadata, { bookTitle: "The Book" }),
    ].join("\n"),
    numbering: pageNumberingConfig(metadata),
  };
}
const scripts = await Promise.all(
  ["./plates.js", "./folios.js"].map((f) =>
    Deno.readTextFile(new URL(f, import.meta.url))
  ),
);

interface Pass {
  // deno-lint-ignore no-explicit-any
  result: { map: any[]; seed: Record<string, string>; problems: unknown[] };
  margins: string[]; // computed bottom-center ::after content per page
  heads: string[][]; // non-empty top margin box ::after contents per page
  widths: number[][]; // top-left/center/right margin box widths per page
  toc: Record<string, string>; // TOC target id → printed number
  ref: string;
}

async function withPage(fn: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><script>${PAGED_JS}</script>${
        scripts.map((s) => `<script>${s}</script>`).join("")
      }<div id="out"></div>`,
    );
    await fn(page);
  } finally {
    await browser.close();
  }
}

// One Paged.js render of `book` from `seed`.
function pass(
  page: Page,
  book: ReturnType<typeof build>,
  seed: Record<string, string>,
) {
  return page.evaluate(
    async ({ html, css, seed, numbering }) => {
      const out = document.getElementById("out")!;
      out.innerHTML = "";
      const url = URL.createObjectURL(
        new Blob([css], { type: "text/css" }),
      );
      // deno-lint-ignore no-explicit-any
      const previewer = new (globalThis as any).Paged.Previewer({
        pageMap: { seed, numbering },
      });
      const chunker = await previewer.preview(html, [url], out);
      const margins = [...out.querySelectorAll(".pagedjs_page")].map(
        (p) => {
          const box = p.querySelector(
            ".pagedjs_margin-bottom-center .pagedjs_margin-content",
          );
          return box ? getComputedStyle(box, "::after").content : "none";
        },
      );
      const heads = [...out.querySelectorAll(".pagedjs_page")].map((p) =>
        [...p.querySelectorAll(".pagedjs_margin-top .pagedjs_margin-content")]
          .map((box) => getComputedStyle(box, "::after").content)
          .filter((c) => c !== "none" && c !== '""')
      );
      const widths = [...out.querySelectorAll(".pagedjs_page")].map((p) =>
        ["left", "center", "right"].map((pos) =>
          (p.querySelector(`.pagedjs_margin-top-${pos}`) as HTMLElement)
            .offsetWidth
        )
      );
      const toc: Record<string, string> = {};
      for (const a of out.querySelectorAll(".toc a.page")) {
        toc[a.getAttribute("href")!.slice(1)] = a.textContent!;
      }
      const ref = out.querySelector("a.ref")?.textContent ?? "";
      previewer.polisher.destroy();
      return {
        result: chunker.pageMapResult,
        margins,
        heads,
        widths,
        toc,
        ref,
      };
    },
    { ...book, seed },
  ) as Promise<Pass>;
}

Deno.test({
  name:
    "folios: the handler writes folios into margins, and the seed into the TOC",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      const book = build(manuscript, metadata);
      const first = await pass(page, book, {});
      assertEquals(first.result.problems, []);
      assertEquals(Object.keys(first.toc), ["matter-preface", "one", "two"]);
      assert(Object.values(first.toc).every((t) => t === "000"));
      const second = await pass(page, book, first.result.seed);
      const { map, seed, problems } = second.result;
      assertEquals(problems, []);
      assertEquals(seed, first.result.seed); // settled in two passes

      assertEquals(second.margins.length, map.length);
      second.margins.forEach((content, i) => {
        const shown = content === "none" ? "" : JSON.parse(content);
        assertEquals(shown, map[i].folioText, `page ${i + 1}`);
      });
      // Roman front matter, then body restarting at 1.
      assertEquals(map[0].display, true);
      const one = map.findIndex((p) => p.anchors.includes("one"));
      assertEquals(map[one].folioText, "1");
      // (the blank verso ahead of a recto opener shows none)
      assert(
        map.slice(1, one).every((p) => p.blank || /^[ivx]+$/.test(p.folioText)),
      );

      const folios = anchorFolios(map);
      for (const [id, text] of Object.entries(second.toc)) {
        assertEquals(text, folios[id], `TOC row #${id}`);
      }
      assertEquals(second.ref, "1");
      // The plate (added outside the flow by plates.js) counts, unnumbered.
      const plate = map.findIndex((p, i) => i > one && p.display);
      assert(plate > one, "plate page in the body");
      assertEquals(map[plate].folioText, "");
      assertEquals(map[plate + 1].folio, map[plate - 1].folio + 2);
      // An opener carries no running title; the page after it does.
      const two = map.findIndex((p) => p.anchors.includes("two"));
      assertEquals([map[two].opener, map[two].chapterTitle], [true, ""]);
      assertEquals(map[two + 1].chapterTitle, "Chapter Two");
    }),
});

Deno.test({
  name: "folios: openers keep the folio but no head, blanks and the " +
    "colophon show neither (Chicago)",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      const chapter = (slug: string, title: string, n: number) =>
        [`{chapter: ${slug}}`, "{title}", title, "", prose(n)].join("\n");
      const book = build(
        [
          chapter("one", "Chapter One", 3),
          chapter("two", "Chapter Two", 4),
          chapter("three", "Chapter Three", 3),
          "{matter: colophon}",
          "Set by hand.",
        ].join("\n"),
        {
          ...metadata,
          elements: { chapter: { "break-before": "right" } },
          running: {
            odd: [{ content: "book-title", area: "top-right" }],
            even: [
              { content: "chapter-title", area: "top-left" },
              { content: "~", area: "top-right" },
            ],
          },
        },
      );
      const { result, margins, heads } = await pass(page, book, {});
      assertEquals(result.problems, []);
      const { map } = result;
      const folio = (i: number) =>
        margins[i] === "none" ? "" : JSON.parse(margins[i]!);

      const openers = map.flatMap((p, i) => p.opener ? [i] : []);
      assertEquals(openers.length, 3);
      for (const i of openers) {
        assertEquals(heads[i], [], `opener page ${i + 1} has no head`);
        assert(folio(i) !== "", `opener page ${i + 1} keeps its folio`);
      }
      const blanks = map.flatMap((p, i) => p.blank ? [i] : []);
      assert(blanks.length > 0, "a forced-recto blank page");
      for (const i of blanks) {
        assertEquals([heads[i], folio(i)], [[], ""], `blank page ${i + 1}`);
      }
      // Running pages still show both, literals included.
      const running = map.findIndex((p) => p.head);
      assert(running >= 0 && heads[running]!.length > 0, "a running head");
      const colophon = map.length - 1;
      assertEquals(map[colophon].display, true);
      assertEquals([heads[colophon], folio(colophon)], [[], ""]);
    }),
});

Deno.test({
  name: "folios: a book ending in a long footnote is neither cut short nor " +
    "stranded",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      // The last id in the book is the note's; Paged.js moves it out of the
      // page content into the footnote area and continues it overleaf.
      const book = build(
        [
          "{chapter: one}",
          "{title}",
          "Chapter One",
          "",
          prose(3),
          "",
          "The end.{footnote: last}",
          "",
          "{note: last}",
          prose(6).replaceAll("\n\n", " "),
        ].join("\n"),
        { ...metadata, notes: { placement: "footnote" } },
      );
      const { result } = await pass(page, book, {});
      assertEquals(result.problems, []);
      const notePage = result.map.findIndex((p) =>
        p.anchors.includes("note-last")
      );
      assert(notePage >= 0, "the note's own id is on a page");
      assert(
        result.map.length > notePage + 1,
        "the note continues on the next page",
      );
    }),
});

// A centre box beside a side box: Paged.js sizes the row from the boxes' text
// in Margins.finalizePage, so the page map must have set it by then.
const title = "A Chapter Title Long Enough to Measure";
const centred = build(
  [
    "{chapter: one}",
    "{title}",
    title,
    "",
    prose(4),
    "{illustration: a | placement: full-page}",
    "Plate A",
    "{illustration: b | placement: full-page}",
    "Plate B",
    "",
    prose(6),
  ].join("\n"),
  {
    ...metadata,
    running: {
      odd: [
        { content: "chapter-title", area: "top-center" },
        { content: "~", area: "top-right" },
      ],
    },
  },
);

Deno.test({
  name: "folios: margin boxes are sized as if the page map's text were " +
    "literal CSS",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      const fromMap = await pass(page, centred, {});
      // The title is long enough to wrap on running pages (a warning, tested
      // below); nothing else is expected.
      assertEquals(
        // deno-lint-ignore no-explicit-any
        fromMap.result.problems.filter((p: any) => !p.warn),
        [],
      );
      const literal = await pass(page, {
        ...centred,
        css: centred.css
          .replaceAll("var(--chapter-title)", JSON.stringify(title))
          .replaceAll('var(--running-off, "~")', '"~"'),
      }, {});
      const { map } = fromMap.result;
      assertEquals(literal.widths.length, map.length);
      // Both plates on one page get an entry, in order.
      const plates = map.flatMap((p, i) => p.display ? [i] : []);
      assertEquals(plates.length, 2);
      assertEquals(plates[1], plates[0]! + 1);
      // Openers and plates blank the head in the page-map render only.
      const heads = map.flatMap((p, i) => p.head && i % 2 === 0 ? [i] : []);
      assert(heads.length >= 3, "several recto running pages");
      for (const i of heads) {
        assertEquals(fromMap.heads[i]!.length, 2, `page ${i + 1} head`);
        assertEquals(fromMap.widths[i], literal.widths[i], `page ${i + 1}`);
      }
    }),
});

Deno.test({
  name: "folios: a page whose margins are sized before its entry is a problem",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      await page.evaluate(() => {
        // deno-lint-ignore no-explicit-any
        const { registeredHandlers } = (globalThis as any).Paged;
        // deno-lint-ignore no-explicit-any
        registeredHandlers.find((h: any) => h.name === "Folios")
          .prototype.afterPageLayout = () => {};
      });
      const { result } = await pass(page, centred, {});
      assertEquals(result.problems[0], {
        page: 1,
        message: "margins were sized before the page map reached this page",
      });
      // Still entered, so the map is whole.
      assert(
        // deno-lint-ignore no-explicit-any
        !result.problems.some((p: any) => p.message === "no page-map entry"),
      );
    }),
});

// An outside folio beside a centred head: Paged.js measures the recto row
// (folio on the right only) wrong, squeezing the head; base.css lays such
// rows out itself.
const outsideFolio = (head: string) =>
  build(
    ["{chapter: one}", "{title}", "Chapter One", "", prose(10)].join("\n"),
    {
      ...metadata,
      numbering: {
        pages: { ...metadata.numbering!.pages, position: "top-outside" },
      },
      running: {
        odd: [{ content: head, area: "top-center" }],
        even: [{ content: head, area: "top-center" }],
      },
    },
  );

Deno.test({
  name: "folios: a centred head beside an outside folio is as wide on a " +
    "recto as on a verso",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      const { result, widths } = await pass(
        page,
        outsideFolio("The Great Gatsby"),
        {},
      );
      assertEquals(result.problems, []);
      const centre = (side: number) =>
        new Set(
          result.map.flatMap((p, i) =>
            p.head && i % 2 === side ? [widths[i]![1]] : []
          ),
        );
      const [recto, verso] = [centre(0), centre(1)];
      assertEquals(recto.size, 1);
      assertEquals(recto, verso);
      // Centred on the text block: the side boxes match.
      result.map.forEach((p, i) => {
        if (p.head) assertEquals(widths[i]![0], widths[i]![2], `page ${i + 1}`);
      });
    }),
});

Deno.test({
  name: "folios: a head that wraps to a second line is a warning",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      const { result } = await pass(
        page,
        outsideFolio("A Running Head Far Too Long for the Measure of Its Page"),
        {},
      );
      const heads = result.map.flatMap((p, i) => p.head ? [i + 1] : []);
      assert(heads.length >= 2, "running pages on both sides");
      assertEquals(
        // deno-lint-ignore no-explicit-any
        (result.problems as any[]).map((p) => [p.page, p.warn, p.message]),
        heads.map((n) => [n, true, "top-center margin box runs to 2 lines"]),
      );
    }),
});

Deno.test({
  name: "folios: a chapter without a title is still an opener",
  ignore: !hasChrome,
  fn: () =>
    withPage(async (page) => {
      const literal = [{ content: "~", area: "top-right" as const }];
      const book = build(
        [
          "{chapter: one}",
          "{title}",
          "Chapter One",
          "",
          prose(4),
          "{chapter: two}",
          "",
          prose(4),
        ].join("\n"),
        { ...metadata, running: { odd: literal, even: literal } },
      );
      const { result, heads } = await pass(page, book, {});
      assertEquals(result.problems, []);
      const two = result.map.findIndex((p) => p.anchors.includes("two"));
      const { opener, head } = result.map[two];
      assertEquals([opener, head, heads[two]], [true, false, []]);
      assert(heads[two + 1]!.length > 0, "the page after it runs");
    }),
});
