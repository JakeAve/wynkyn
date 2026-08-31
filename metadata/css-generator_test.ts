// metadata/css-generator_test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { generateDomCSS } from "./css-generator.ts";
import { generatePagedCSS } from "./css-generator.ts";

Deno.test("body maps to .bml with font alias resolved", () => {
  const css = generateDomCSS({
    fonts: { body: "EB Garamond" },
    elements: { body: { "font-family": "body", "font-size": "11pt" } },
  });
  assertStringIncludes(css, '.bml {');
  assertStringIncludes(css, 'font-family: "EB Garamond";');
  assertStringIncludes(css, "font-size: 11pt;");
});

Deno.test("nested page-type elements become descendant selectors", () => {
  const css = generateDomCSS({
    elements: { "title-page": { title: { "font-size": "26pt", "text-align": "center" } } },
  });
  assertStringIncludes(css, ".matter-title-page .title {");
  assertStringIncludes(css, "font-size: 26pt;");
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

Deno.test("content property goes to ::before, value quoted", () => {
  const css = generateDomCSS({ elements: { break: { content: "✦" } } });
  assertStringIncludes(css, '.break::before {');
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
  const css = generateDomCSS({ elements: { body: { "font-family": "serif" } } });
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
  assertStringIncludes(css, "@page :right {\n  margin-left: 22mm;\n  margin-right: 16mm;\n}");
  assertStringIncludes(css, "@page :left {\n  margin-left: 16mm;\n  margin-right: 22mm;\n}");
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
  assertStringIncludes(css, ".zone-front { page: front; }");
  assertStringIncludes(css, "@page front {\n  @bottom-center {\n    content: counter(page, lower-roman);");
  assertStringIncludes(css, "content: counter(page, decimal);");
  assert(!css.includes("@page back {")); // show:false → no margin box for back
  assertStringIncludes(css, ".zone-body { counter-reset: page 1; }");
});

Deno.test("running header entries: odd→:right, even→:left, string-set hooks (§4.8)", () => {
  const css = generatePagedCSS(
    {
      running: {
        odd: [{ content: "book-title", area: "top-right", "font-size": "8pt" }],
        even: [{ content: "chapter-title", area: "top-left", "font-style": "italic" }],
      },
    },
    { bookTitle: "Common Sense" },
  );
  assertStringIncludes(css, ".chapter .title { string-set: chapter-title content(text); }");
  assertStringIncludes(css, ".part .title { string-set: part-title content(text); }");
  assertStringIncludes(css, '@page :right {\n  @top-right {\n    content: "Common Sense";\n    font-size: 8pt;');
  assertStringIncludes(css, "@page :left {\n  @top-left {\n    content: string(chapter-title);\n    font-style: italic;");
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
  assertStringIncludes(css, "content: counter(page);");
  assertStringIncludes(css, 'content: "· 1943 ·";');
});

Deno.test("TOC folios: page link, zone styles; ref unchanged (§4.11)", () => {
  const css = generatePagedCSS({
    numbering: { pages: { "front-matter": { style: "roman-lower" }, "back-matter": { style: "alpha-upper" } } },
  });
  assertStringIncludes(css, ".toc a.page::after { content: target-counter(attr(href url), page); }");
  assertStringIncludes(css, ".toc .toc-front a.page::after { content: target-counter(attr(href url), page, lower-roman); }");
  assertStringIncludes(css, ".toc .toc-back a.page::after { content: target-counter(attr(href url), page, upper-alpha); }");
  assertStringIncludes(css, "a.ref::after { content: target-counter(attr(href url), page); }");
  assert(!css.includes("a.entry::after"));
});

Deno.test("TOC zone folios default to decimal when a zone has no style or 'none'", () => {
  const css = generatePagedCSS({ numbering: { pages: { "front-matter": { style: "none" } } } });
  assertStringIncludes(css, ".toc .toc-front a.page::after { content: target-counter(attr(href url), page, decimal); }");
  assertStringIncludes(css, ".toc .toc-back a.page::after { content: target-counter(attr(href url), page, decimal); }");
});

Deno.test("footnote float only when placement is footnote (§4.10)", () => {
  assertStringIncludes(
    generatePagedCSS({ notes: { placement: "footnote" } }),
    ".note { float: footnote; }",
  );
  assert(!generatePagedCSS({ notes: { placement: "endnote" } }).includes("float: footnote"));
  assert(!generatePagedCSS({}).includes("float: footnote"));
});

import { generateFontLinks } from "./css-generator.ts";

Deno.test("font links: one css2 stylesheet link with all families and default variants", () => {
  const html = generateFontLinks({
    fonts: { body: "EB Garamond", display: "Playfair Display" },
  });
  assertStringIncludes(html, '<link rel="preconnect" href="https://fonts.googleapis.com">');
  assertStringIncludes(html, "family=EB+Garamond:ital,wght@0,400;0,700;1,400;1,700");
  assertStringIncludes(html, "family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700");
  assertStringIncludes(html, "display=swap");
  assertEquals((html.match(/rel="stylesheet"/g) ?? []).length, 1);
});

Deno.test("no fonts → empty string", () => {
  assertEquals(generateFontLinks({}), "");
});

Deno.test("generateFontLinks percent-encodes special characters in family names", () => {
  const html = generateFontLinks({ fonts: { body: 'My "Weird" Font' } });
  assertStringIncludes(html, encodeURIComponent('My "Weird" Font').replace(/%20/g, "+"));
  assert(!html.includes('"Weird"'));
});

Deno.test("page-number css props are emitted in the zone's @bottom-center box", () => {
  const css = generatePagedCSS({
    fonts: { display: "Cormorant Garamond" },
    numbering: {
      pages: { body: { style: "arabic", show: true, css: { "font-size": "9pt", "font-family": "display" } } },
    },
  });
  const box = css.slice(css.indexOf("@page body {"));
  assertStringIncludes(box, "content: counter(page, decimal);");
  assertStringIncludes(box, "font-size: 9pt;");
  assertStringIncludes(box, 'font-family: "Cormorant Garamond";');
});

Deno.test("page numbering 'words' falls back to decimal — CSS counters have no spelled form (§4.7)", () => {
  const css = generatePagedCSS({ numbering: { pages: { body: { style: "words" } } } });
  assertStringIncludes(css, "@page body {\n  @bottom-center {\n    content: counter(page, decimal);");
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
  assertStringIncludes(css, ".matter-toc .toc-part .number {\n  font-variant: small-caps;\n}");
});

Deno.test("toc leader content becomes the --leader custom property, not ::before (§4.5)", () => {
  const css = generateDomCSS({
    elements: { toc: { leader: { content: ". ", opacity: "0.5" } } },
  });
  assertStringIncludes(css, '.matter-toc .leader {\n  --leader: ". ";\n  opacity: 0.5;\n}');
  assert(!css.includes(".matter-toc .leader::before"));
});

Deno.test("break content still goes to ::before (unchanged)", () => {
  const css = generateDomCSS({ elements: { break: { content: "✦" } } });
  assertStringIncludes(css, '.break::before {\n  content: "✦";\n}');
});
