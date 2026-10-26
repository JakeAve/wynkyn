import { assert } from "@std/assert";

// web/tokens.css and design-language.md name the same tokens. In the doc a
// name ending in `-*` stands for its family (`--s-*`), and a struck-through
// name (~~`--soft`~~) is retired, so it must not exist.
const css = await Deno.readTextFile(new URL("./tokens.css", import.meta.url));
const doc = (await Deno.readTextFile(
  new URL("../design-language.md", import.meta.url),
)).replace(/~~.*?~~/g, "");

const declared = new Set(
  [...css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1]!),
);
const named = new Set(
  [...doc.matchAll(/--[a-z][a-z0-9-]*\*?/g)].map((m) => m[0]),
);
const families = [...named].filter((n) => n.endsWith("*"))
  .map((n) => n.slice(0, -1));
const inFamily = (t: string) => families.some((f) => t.startsWith(f));

Deno.test("every token in tokens.css is documented in design-language.md", () => {
  const missing = [...declared].filter((t) => !named.has(t) && !inFamily(t));
  assert(missing.length === 0, `not in design-language.md: ${missing}`);
});

Deno.test("every token design-language.md names exists in tokens.css", () => {
  const missing = [...named].filter((n) =>
    n.endsWith("*")
      ? ![...declared].some((t) => t.startsWith(n.slice(0, -1)))
      : !declared.has(n)
  );
  assert(missing.length === 0, `not in web/tokens.css: ${missing}`);
});

// Chrome lengths are rem tokens (design-language.md §4.1); px only for 1px
// hairlines and 2px rings. Rules for the book's own geometry are skipped: the
// preview's pages (.pagedjs_*) and the strokes of the sheet drawing
// (#sheet-view .sheet .paper etc.), which are drawn, not chrome.
Deno.test("app.css uses no px beyond hairlines and rings", async () => {
  const app = (await Deno.readTextFile(new URL("./app.css", import.meta.url)))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(
      /[^{}]*\{[^{}]*\}/g,
      (rule) =>
        /\.pagedjs_|#sheet-view \.sheet \./.test(rule.split("{")[0]!)
          ? ""
          : rule,
    );
  const stray = [...app.matchAll(/(?<![\w.-])-?([\d.]+)px\b/g)]
    .filter((m) => m[1] !== "1" && m[1] !== "2").map((m) => m[0]);
  assert(stray.length === 0, `px in web/app.css: ${stray}`);
});
