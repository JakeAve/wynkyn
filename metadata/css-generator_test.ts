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

Deno.test("TOC and ref target-counter rules always emitted (§4.11)", () => {
  const css = generatePagedCSS({});
  assertStringIncludes(css, ".toc a.entry::after { content: leader('.') target-counter(attr(href url), page); }");
  assertStringIncludes(css, "a.ref::after { content: target-counter(attr(href url), page); }");
});

Deno.test("footnote float only when placement is footnote (§4.10)", () => {
  assertStringIncludes(
    generatePagedCSS({ notes: { placement: "footnote" } }),
    ".note { float: footnote; }",
  );
  assert(!generatePagedCSS({ notes: { placement: "endnote" } }).includes("float: footnote"));
  assert(!generatePagedCSS({}).includes("float: footnote"));
});
