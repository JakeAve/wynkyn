// base-css_test.ts — structural regression test for base.css's TOC rules.
// Placed beside base.css (not a .ts module, so no import — just a text-based
// structural check), following the repo's X_test.ts-next-to-X convention.
import { assert, assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { generateDomCSS } from "../metadata/css-generator.ts";
import { parse } from "../parser/parser.ts";
import { hasChrome } from "../testing/chrome.ts";
import { render } from "./render.ts";

Deno.test("TOC rules in base.css keep zero own-specificity via :where() (review fix, plan 7 task 4)", () => {
  const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments so their prose doesn't look like a selector
  // Every selector whose right-hand side lives under .bml .toc must wrap that
  // prefix in :where(...) so a generated two-class override (e.g.
  // ".matter-toc .toc-part") always outranks it. A bare ".bml .toc X" rule
  // would win over that override regardless of stylesheet order, since
  // base.css is emitted before domCss (server/pipeline.ts).
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1]!) // safe: capture group 1 always matches inside the outer match
    .flatMap((selectorList) => selectorList.split(","))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.includes(".toc"));
  assert(selectors.length > 0, "expected to find .toc rules in base.css");
  for (const selector of selectors) {
    assert(
      selector.startsWith(":where(.bml .toc)"),
      `TOC selector must wrap its .bml .toc prefix in :where(): "${selector}"`,
    );
  }
});

Deno.test("base.css uses no adjacent-sibling combinator (Paged.js drops those rules)", () => {
  // Paged.js 0.4.3 silently discards any rule whose selector contains `+`, and
  // discards the whole grouped rule with it — so one `h1 + p` in a selector
  // list took `.verse`, `.stanza` and `.has-dropcap` down with it and every
  // printed book indented paragraphs that should have been flush.
  // .claude/skills/architecture/references/pagedjs-plus-combinator.md.
  const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders = [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1]!.replace(/\s+/g, " ").trim())
    .filter((s) => s.includes("+"));
  assert(
    offenders.length === 0,
    `selectors with a "+" combinator are dropped by Paged.js: ${
      offenders.join(" | ")
    }`,
  );
});

Deno.test("display matter's page rule comes after the zone rules (Paged.js goes by order)", () => {
  // Paged.js applies `page` per selector in source order, ignoring
  // specificity (.claude/skills/architecture/references/pagedjs-breaks.md).
  const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const pageRule = (name: string) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => new RegExp(`page:\\s*${name}\\s*;`).test(m[2]!))
      .map((m) => ({
        at: m.index,
        sels: m[1]!.split(",").map((x) => x.trim()),
      }));
  const [display, ...more] = pageRule("display");
  assert(display && !more.length, "expected one `page: display` rule");
  for (const zone of ["front", "body", "back"]) {
    const [rule] = pageRule(zone);
    assertEquals(rule?.sels, [`.zone-${zone}`]);
    assert(rule!.at < display.at, `.zone-${zone} must come before display`);
  }
});

Deno.test({
  name:
    "lines and opening paragraphs stay flush even when a book sets its own paragraph indent",
  ignore: !hasChrome,
  fn: async () => {
    const html = render(parse([
      "{matter: title-page}",
      "{title}",
      "T",
      "{publisher}",
      "Scribner",
      "{matter: dedication}",
      "Once again\\",
      "to Zelda",
      "{chapter: a}",
      "{title}",
      "A",
      "",
      "Opening.",
      "",
      "Indented.",
      "",
      "{heading}",
      "H",
      "",
      "After heading.",
      "",
      "{pullquote}",
      "Pulled.",
      "{/pullquote}",
      "",
      "After pullquote.",
      "",
      "{poem}",
      "A line.",
      "{/poem}",
      "{attribution}",
      "Anon.",
      "",
      "{sidebar}",
      "Boxed.",
      "{/sidebar}",
      "",
      "{columns: 2}",
      "Left.",
      "",
      "{col}",
      "",
      "Right.",
      "{/columns}",
      "{matter: colophon}",
      "{typeface}",
      "Set in Garamond.",
    ].join("\n")));
    const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url)) +
      generateDomCSS({
        elements: {
          paragraph: { "text-indent": "20px" },
          colophon: { "text-indent": "7px" },
        },
      });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>${css}</style>${html}`);
      const indents = Object.fromEntries(
        await page.$$eval(
          ".bml p",
          (ps) =>
            ps.map((p) => [p.textContent!, getComputedStyle(p).textIndent]),
        ),
      );
      assertEquals(indents, {
        "Scribner": "0px",
        "Once againto Zelda": "0px",
        "Opening.": "0px",
        "Indented.": "20px",
        "After heading.": "0px",
        "Pulled.": "0px",
        "After pullquote.": "20px",
        "A line.": "0px",
        "Anon.": "0px",
        "Boxed.": "0px",
        "Left.": "0px",
        "Right.": "0px",
        // The section's own indent reaches its lines.
        "Set in Garamond.": "7px",
      });
    } finally {
      await browser.close();
    }
  },
});

Deno.test({
  name:
    "a book's quote, poem, break and illustration margins beat base.css; an epigraph centres as wide as its longest line",
  ignore: !hasChrome,
  fn: async () => {
    const html = render(parse([
      "{chapter: a}",
      "{title}",
      "A",
      "",
      "{quote}",
      "Quoted.",
      "{/quote}",
      "",
      "{poem}",
      "A line.",
      "{/poem}",
      "",
      "{break}",
      "",
      "{illustration: fig}",
      "",
      "{epigraph}",
      "Short line,\\",
      "and a longer second line.",
      "{attribution}",
      "Anon.",
    ].join("\n")));
    const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url)) +
      generateDomCSS({
        elements: {
          quote: { "margin-left": "30px" },
          poem: { "margin-left": "40px" },
          break: { "margin-top": "50px" },
          illustration: { "margin-top": "60px" },
        },
      });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<style>body { margin: 0; width: 600px }${css}</style>${html}`,
      );
      const m = await page.evaluate(() => {
        const box = (s: string) => {
          const r = document.querySelector(s)!.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.right)];
        };
        const text = document.querySelector(".epigraph .text")!;
        const range = document.createRange();
        range.selectNodeContents(text);
        return {
          quote: getComputedStyle(document.querySelector(".quote")!).marginLeft,
          poem: getComputedStyle(document.querySelector(".poem")!).marginLeft,
          break: getComputedStyle(document.querySelector(".break")!).marginTop,
          illustration: getComputedStyle(
            document.querySelector(".illustration")!,
          ).marginTop,
          epigraph: box(".epigraph"),
          longest: Math.round(range.getBoundingClientRect().width),
        };
      });
      assertEquals(m.quote, "30px");
      assertEquals(m.poem, "40px");
      assertEquals(m.break, "50px");
      assertEquals(m.illustration, "60px");
      const [left, right] = m.epigraph as [number, number];
      assertEquals(right - left, m.longest, "shrinks to its longest line");
      assert(Math.abs(left - (600 - right)) <= 1, `centred: ${left}..${right}`);
    } finally {
      await browser.close();
    }
  },
});

Deno.test({
  name:
    "each style key reaches its own element and no other, over base.css (CSS audit)",
  ignore: !hasChrome,
  fn: async () => {
    const html = render(
      parse([
        "{matter: title-page}",
        "{title}",
        "T",
        "{author}",
        "Ann",
        "{matter: dedication}",
        "For you.",
        "{part: one}",
        "{title}",
        "Part One",
        "{chapter: a}",
        "{title}",
        "A",
        "",
        "{dropcap}",
        "Opening, see {ref: a}.{footnote: n}",
        "",
        "{note: n}",
        "The note.",
        "",
        "{heading}",
        "H",
        "",
        "{verses: v}",
        "A verse.",
        "{/verses}",
        "",
        "{columns: 2}",
        "Left.",
        "{col}",
        "Right.",
        "{/columns}",
      ].join("\n")),
      { notes: { placement: "endnote" } },
    );
    const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url)) +
      generateDomCSS({
        elements: {
          // Before `part` and `verses`, so order alone can't save them.
          verses: { number: { "font-size": "7px" } },
          chapter: { title: { color: "rgb(0, 0, 255)" } },
          part: {
            title: { color: "rgb(255, 0, 0)" },
            number: { "letter-spacing": "9px" },
          },
          paragraph: { "text-indent": "20px" },
          "title-page": { author: { "text-indent": "13px" } },
          dropcap: { float: "none", "padding-right": "3px" },
          heading: { hyphens: "auto" },
          columns: { gap: "17px" },
          footnote: { "font-size": "6px" },
        },
      });
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>${css}</style>${html}`);
      const got = await page.evaluate(() => {
        const cs = (s: string) => getComputedStyle(document.querySelector(s)!);
        return {
          partTitle: cs(".part > .title").color,
          chapterTitle: cs(".chapter .title").color,
          verseNumber: `${cs(".verse .number").fontSize} ${
            cs(".verse .number").letterSpacing
          }`,
          author: cs(".author").textIndent,
          dedication: cs(".matter-dedication p").textIndent,
          dropcap: `${cs(".dropcap").float} ${cs(".dropcap").paddingRight}`,
          heading: cs(".heading").hyphens,
          columns: cs(".columns-parallel").columnGap,
          note: cs(".notes .note").fontSize,
          ink: [".footnote-anchor a", "a.ref"].map((s) =>
            `${cs(s).color} ${cs(s).textDecorationLine}`
          ),
        };
      });
      assertEquals(got, {
        partTitle: "rgb(255, 0, 0)",
        chapterTitle: "rgb(0, 0, 255)", // the part's red stays on the part
        verseNumber: "7px normal", // no chapter or part number styles
        author: "13px", // a line's own key beats display matter's inherit
        dedication: "0px", // display matter ignores the paragraph indent
        dropcap: "none 3px",
        heading: "auto",
        columns: "17px",
        note: "6px",
        ink: Array(2).fill("rgb(0, 0, 0) none"),
      });
    } finally {
      await browser.close();
    }
  },
});
