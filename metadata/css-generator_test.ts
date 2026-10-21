// metadata/css-generator_test.ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateDomCSS } from "./css-generator.ts";
import {
  DEFAULT_FOLIO_GAP,
  DEFAULT_HEAD_GAP,
  generatePagedCSS,
  pageNumberingConfig,
} from "./css-generator.ts";

Deno.test("body maps to .bml with font alias resolved", () => {
  const css = generateDomCSS({
    fonts: { body: "EB Garamond" },
    elements: { body: { "font-family": "body", "font-size": "11pt" } },
  });
  assertStringIncludes(css, ".bml {");
  assertStringIncludes(css, 'font-family: "EB Garamond";');
  assertStringIncludes(css, "font-size: 11pt;");
});

Deno.test("nested page-type elements become descendant selectors", () => {
  const css = generateDomCSS({
    elements: {
      "title-page": { title: { "font-size": "26pt", "text-align": "center" } },
    },
  });
  assertStringIncludes(css, ".matter-title-page .title {");
  assertStringIncludes(css, "font-size: 26pt;");
});

Deno.test("a nested em styles the emphasis element, not an .em class (§4.5)", () => {
  const css = generateDomCSS({
    elements: {
      "title-page": { subtitle: { em: { "font-style": "normal" } } },
    },
  });
  assertStringIncludes(css, ".matter-title-page .subtitle em {");
});

Deno.test("flat and nested props may mix on one key", () => {
  const css = generateDomCSS({
    elements: {
      verses: { "font-size": "10pt", number: { "vertical-align": "super" } },
    },
  });
  assertStringIncludes(css, ".verses {");
  assertStringIncludes(css, ".verses .number {");
});

Deno.test("prose-matter fans out to the three prose matter types", () => {
  const css = generateDomCSS({
    elements: { "prose-matter": { title: { "font-size": "16pt" } } },
  });
  assertStringIncludes(css, ".matter-foreword .title");
  assertStringIncludes(css, ".matter-preface .title");
  assertStringIncludes(css, ".matter-introduction .title");
});

Deno.test("em maps to .bml em", () => {
  const css = generateDomCSS({ elements: { em: { "font-style": "italic" } } });
  assertStringIncludes(css, ".bml em {");
});

Deno.test("paragraph maps to .bml p", () => {
  const css = generateDomCSS({
    elements: { paragraph: { "text-indent": "0", "margin-top": "0.5lh" } },
  });
  assertStringIncludes(
    css,
    ".bml p {\n  text-indent: 0;\n  margin-top: 0.5lh;\n}",
  );
  assert(!css.includes("+"));
});

Deno.test("a book without paragraph emits no paragraph rule", () => {
  const css = generateDomCSS({ elements: { body: { "font-size": "11pt" } } });
  assert(!css.includes(".bml p"));
});

Deno.test("content property goes to ::before, value quoted", () => {
  const css = generateDomCSS({ elements: { break: { content: "✦" } } });
  assertStringIncludes(css, ".break::before {");
  assertStringIncludes(css, 'content: "✦";');
});

Deno.test("is section emits .is-* classes with alias resolution", () => {
  const css = generateDomCSS({
    fonts: { mono: "Courier Prime" },
    is: { telegram: { "font-family": "mono", "text-transform": "uppercase" } },
  });
  assertStringIncludes(css, ".is-telegram {");
  assertStringIncludes(css, 'font-family: "Courier Prime";');
});

Deno.test("unknown font-family values pass through untouched", () => {
  const css = generateDomCSS({
    elements: { body: { "font-family": "serif" } },
  });
  assertStringIncludes(css, "font-family: serif;");
});

Deno.test("empty metadata produces empty string", () => {
  assertEquals(generateDomCSS({}), "");
});

Deno.test("page size and mirrored margins (§4.3)", () => {
  const css = generatePagedCSS({
    page: {
      size: "5.5in 8.5in",
      margins: { top: "18mm", bottom: "22mm", inside: "22mm", outside: "16mm" },
    },
  });
  assertStringIncludes(css, "size: 5.5in 8.5in;");
  assertStringIncludes(css, "margin-top: 18mm;");
  // recto (:right): spine on the left
  assertStringIncludes(
    css,
    "@page :right {\n  margin-left: 22mm;\n  margin-right: 16mm;\n}",
  );
  assertStringIncludes(
    css,
    "@page :left {\n  margin-left: 16mm;\n  margin-right: 22mm;\n}",
  );
});

Deno.test("page numbering per zone with style mapping (§4.7)", () => {
  const css = generatePagedCSS({
    numbering: {
      pages: {
        "front-matter": { style: "roman-lower", show: true },
        body: { style: "arabic", show: true },
        "back-matter": { style: "arabic", show: false },
      },
    },
  });
  assert(!css.includes("page: front")); // zone page names live in base.css
  assertStringIncludes(
    css,
    "@page front {\n  @bottom-center {\n    content: var(--folio);",
  );
  assertStringIncludes(
    css,
    "@page body {\n  @bottom-center {\n    content: var(--folio);",
  );
  assert(!css.includes("@page back {")); // show:false → no margin box for back
  // Numbers come from the page map, not Paged.js counters.
  assert(!css.includes("counter-reset: page"));
  assert(!css.includes("counter(page"));
});

Deno.test("pageNumberingConfig: per-zone style and show, defaulting to arabic/shown (§4.7)", () => {
  assertEquals(pageNumberingConfig({}), {
    front: { style: "arabic", show: true },
    body: { style: "arabic", show: true },
    back: { style: "arabic", show: true },
  });
  assertEquals(
    pageNumberingConfig({
      numbering: {
        pages: {
          "front-matter": { style: "roman-lower" },
          body: { show: false },
          "back-matter": { style: "none", show: true },
        },
      },
    }),
    {
      front: { style: "roman-lower", show: true },
      body: { style: "arabic", show: false },
      back: { style: "none", show: true },
    },
  );
});

Deno.test("running header entries: odd→body:right, even→body:left, page-map variables (§4.8)", () => {
  const css = generatePagedCSS(
    {
      running: {
        odd: [{ content: "book-title", area: "top-right", "font-size": "8pt" }],
        even: [{
          content: "chapter-title",
          area: "top-left",
          "font-style": "italic",
        }],
      },
    },
    { bookTitle: "Common Sense" },
  );
  assert(!css.includes("string-set"));
  assert(!css.includes("string("));
  assertStringIncludes(
    css,
    '@page body:right {\n  @top-right {\n    content: var(--running-off, "Common Sense");\n    vertical-align: bottom;\n    padding-bottom: 4mm;\n    font-size: 8pt;',
  );
  assertStringIncludes(
    css,
    "@page body:left {\n  @top-left {\n    content: var(--chapter-title);\n    vertical-align: bottom;\n    padding-bottom: 4mm;\n    font-style: italic;",
  );
});

Deno.test("running content vocabulary: page-number, none, literal (§4.8)", () => {
  const css = generatePagedCSS({
    running: {
      odd: [
        { content: "page-number", area: "bottom-right" },
        { content: "· 1943 ·", area: "top-center" },
      ],
    },
  });
  assertStringIncludes(css, "content: var(--folio);");
  // Literals go through --running-off so the page map can blank them on
  // openers and blank pages; page-number is a folio and keeps showing.
  assertStringIncludes(css, 'content: var(--running-off, "· 1943 ·");');
});

Deno.test("TOC and ref numbers are written by the page map, not CSS (§4.11)", () => {
  const css = generatePagedCSS({
    numbering: { pages: { "front-matter": { style: "roman-lower" } } },
  });
  assert(!css.includes("target-counter"));
  assert(!css.includes("::after"));
});

Deno.test("footnote float only when placement is footnote (§4.10)", () => {
  assertStringIncludes(
    generatePagedCSS({ notes: { placement: "footnote" } }),
    ".note { float: footnote; }",
  );
  assert(
    !generatePagedCSS({ notes: { placement: "endnote" } }).includes(
      "float: footnote",
    ),
  );
  assert(!generatePagedCSS({}).includes("float: footnote"));
});

import { generateFontLinks } from "./css-generator.ts";

Deno.test("font links: one css2 stylesheet link with all families and default variants", () => {
  const html = generateFontLinks({
    fonts: { body: "EB Garamond", display: "Playfair Display" },
  });
  assertStringIncludes(
    html,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
  );
  assertStringIncludes(
    html,
    "family=EB+Garamond:ital,wght@0,400;0,700;1,400;1,700",
  );
  assertStringIncludes(
    html,
    "family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700",
  );
  assertStringIncludes(html, "display=swap");
  assertEquals((html.match(/rel="stylesheet"/g) ?? []).length, 1);
});

Deno.test("no fonts → empty string", () => {
  assertEquals(generateFontLinks({}), "");
});

Deno.test("generateFontLinks percent-encodes special characters in family names", () => {
  const html = generateFontLinks({ fonts: { body: 'My "Weird" Font' } });
  assertStringIncludes(
    html,
    encodeURIComponent('My "Weird" Font').replace(/%20/g, "+"),
  );
  assert(!html.includes('"Weird"'));
});

Deno.test("page-number css props are emitted in the zone's @bottom-center box", () => {
  const css = generatePagedCSS({
    fonts: { display: "Cormorant Garamond" },
    numbering: {
      pages: {
        body: {
          style: "arabic",
          show: true,
          css: { "font-size": "9pt", "font-family": "display" },
        },
      },
    },
  });
  const box = css.slice(css.indexOf("@page body {"));
  assertStringIncludes(box, "content: var(--folio);");
  assertStringIncludes(box, "font-size: 9pt;");
  assertStringIncludes(box, 'font-family: "Cormorant Garamond";');
});

Deno.test("page numbering 'words' still emits the folio box — formatting is the page map's (§4.7)", () => {
  const css = generatePagedCSS({
    numbering: { pages: { body: { style: "words" } } },
  });
  assertStringIncludes(
    css,
    "@page body {\n  @bottom-center {\n    content: var(--folio);",
  );
});

Deno.test("nested sub-elements emit descendant selectors at any depth (§4.5)", () => {
  const css = generateDomCSS({
    elements: {
      toc: {
        "toc-part": {
          "margin-top": "1.4em",
          number: { "font-variant": "small-caps" },
        },
      },
    },
  });
  assertStringIncludes(css, ".matter-toc .toc-part {\n  margin-top: 1.4em;\n}");
  assertStringIncludes(
    css,
    ".matter-toc .toc-part .number {\n  font-variant: small-caps;\n}",
  );
});

Deno.test("toc leader content becomes the --leader custom property, not ::before (§4.5)", () => {
  const css = generateDomCSS({
    elements: { toc: { leader: { content: ". ", opacity: "0.5" } } },
  });
  assertStringIncludes(
    css,
    '.matter-toc .leader {\n  --leader: ". ";\n  opacity: 0.5;\n}',
  );
  assert(!css.includes(".matter-toc .leader::before"));
});

Deno.test("break content still goes to ::before (unchanged)", () => {
  const css = generateDomCSS({ elements: { break: { content: "✦" } } });
  assertStringIncludes(css, '.break::before {\n  content: "✦";\n}');
});

Deno.test("pages.css styles every zone's folio; a zone's own css overrides it (§4.7)", () => {
  const css = generatePagedCSS({
    fonts: { body: "Crimson Pro", display: "Cormorant Garamond" },
    numbering: {
      pages: {
        css: { "font-size": "9pt", "font-family": "body" },
        "back-matter": { css: { "font-family": "display" } },
      },
    },
  });
  for (const zone of ["front", "body", "back"]) {
    const box = css.slice(css.indexOf(`@page ${zone} {`));
    assertStringIncludes(box, "font-size: 9pt;");
  }
  assertStringIncludes(
    css.slice(css.indexOf("@page front {")),
    'font-family: "Crimson Pro";',
  );
  assertStringIncludes(
    css.slice(css.indexOf("@page back {")),
    'font-family: "Cormorant Garamond";',
  );
});

Deno.test("running-entry font aliases resolve like element styles (§4.8)", () => {
  const css = generatePagedCSS({
    fonts: { display: "Cormorant Garamond" },
    running: {
      odd: [{
        content: "book-title",
        area: "top-right",
        "font-family": "display",
        "font-size": "8pt",
      }],
    },
  });
  assertStringIncludes(css, 'font-family: "Cormorant Garamond";');
  assertStringIncludes(css, "font-size: 8pt;");
});

Deno.test("generatePagedCSS anchors the folio a gap below the text block", () => {
  const css = generatePagedCSS({ numbering: { pages: {} } });
  assertStringIncludes(
    css,
    `@page body {\n  @bottom-center {\n    content: var(--folio);\n    vertical-align: top;\n    padding-top: ${DEFAULT_FOLIO_GAP};`,
  );
  // A book's own keys win over the default.
  const own = generatePagedCSS({
    numbering: {
      pages: { gap: "7mm", body: { css: { "vertical-align": "middle" } } },
    },
  });
  const box = own.slice(own.indexOf("@page body {"));
  assertStringIncludes(box, "vertical-align: middle;");
  assertStringIncludes(box, "padding-top: 7mm;");
});

Deno.test("running heads anchor a gap above the text block (§4.8)", () => {
  const css = generatePagedCSS({
    running: {
      odd: [{ content: "book-title", area: "top-right" }],
      even: [{ content: "chapter-title", area: "bottom-left" }],
    },
  });
  assertStringIncludes(
    css,
    `@top-right {\n    content: var(--running-off, "");\n    vertical-align: bottom;\n    padding-bottom: ${DEFAULT_HEAD_GAP};`,
  );
  assertStringIncludes(css, `vertical-align: top;\n    padding-top: 4mm;`);
  const gapped = generatePagedCSS({
    running: {
      gap: "6mm",
      odd: [{ content: "x", area: "top-center", "padding-bottom": "2mm" }],
    },
  });
  assertStringIncludes(gapped, "padding-bottom: 2mm;");
  assert(!gapped.includes("padding-bottom: 6mm"));
});

Deno.test("folio position: outside mirrors to the fore-edge, top flips the anchor (§4.7)", () => {
  const css = generatePagedCSS({
    numbering: { pages: { position: "top-outside" } },
  });
  assertStringIncludes(
    css,
    "@page body:right {\n  @top-right {\n    content: var(--folio);\n    vertical-align: bottom;\n    padding-bottom: 5mm;",
  );
  assertStringIncludes(css, "@page body:left {\n  @top-left {");
  assert(!css.includes("@bottom-center"));
  const display = css.slice(css.indexOf("@page display {"));
  assertStringIncludes(display, "@top-right {\n    content: none;");
  assertStringIncludes(display, "@top-left {\n    content: none;");
  assertStringIncludes(
    generatePagedCSS({ numbering: { pages: { position: "top-center" } } }),
    "@page front {\n  @top-center {",
  );
});
