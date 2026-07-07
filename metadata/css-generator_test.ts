// metadata/css-generator_test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { generateDomCSS } from "./css-generator.ts";

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
