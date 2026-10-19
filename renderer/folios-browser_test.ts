import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { parse } from "../parser/parser.ts";
import {
  generateDomCSS,
  generatePagedCSS,
  pageNumberingConfig,
} from "../metadata/css-generator.ts";
import type { Metadata } from "../metadata/types.ts";
import { render } from "./render.ts";
import "./folios.js";

const hasChrome = await Deno.stat("/Applications/Google Chrome.app").then(
  () => true,
  () => false,
);

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
const doc = parse(manuscript);
const html = render(doc, { numbering: metadata.numbering });
const css = [
  await Deno.readTextFile(new URL("./base.css", import.meta.url)),
  generateDomCSS(metadata),
  generatePagedCSS(metadata, { bookTitle: "The Book" }),
].join("\n");
const numbering = pageNumberingConfig(metadata);
const scripts = await Promise.all(
  ["./plates.js", "./folios.js"].map((f) =>
    Deno.readTextFile(new URL(f, import.meta.url))
  ),
);

interface Pass {
  // deno-lint-ignore no-explicit-any
  result: { map: any[]; seed: Record<string, string>; problems: unknown[] };
  margins: string[]; // computed bottom-center ::after content per page
  toc: Record<string, string>; // TOC target id → printed number
  ref: string;
}

Deno.test({
  name:
    "folios: the handler writes folios into margins, and the seed into the TOC",
  ignore: !hasChrome,
  fn: async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<!doctype html><script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.js"></script>${
          scripts.map((s) => `<script>${s}</script>`).join("")
        }<div id="out"></div>`,
      );
      const pass = (seed: Record<string, string>) =>
        page.evaluate(
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
            const toc: Record<string, string> = {};
            for (const a of out.querySelectorAll(".toc a.page")) {
              toc[a.getAttribute("href")!.slice(1)] = a.textContent!;
            }
            const ref = out.querySelector("a.ref")!.textContent!;
            previewer.polisher.destroy();
            return { result: chunker.pageMapResult, margins, toc, ref };
          },
          { html, css, seed, numbering },
        ) as Promise<Pass>;

      const first = await pass({});
      assertEquals(first.result.problems, []);
      assertEquals(Object.keys(first.toc), ["matter-preface", "one", "two"]);
      assert(Object.values(first.toc).every((t) => t === "000"));
      const second = await pass(first.result.seed);
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
      assert(map.slice(1, one).every((p) => /^[ivx]+$/.test(p.folioText)));

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
      assertEquals(
        map.find((p) => p.anchors.includes("two")).chapterTitle,
        "Chapter Two",
      );
    } finally {
      await browser.close();
    }
  },
});
