// base-css_test.ts — structural regression test for base.css's TOC rules.
// Placed beside base.css (not a .ts module, so no import — just a text-based
// structural check), following the repo's X_test.ts-next-to-X convention.
import { assert } from "@std/assert";

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
  // docs/pagedjs-plus-combinator.md.
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

Deno.test("base.css names the zone pages before any break-before rule (Paged.js only dedups the zone break then)", () => {
  // Paged.js drops an explicit `break-before: page` when the element already
  // starts a differently named page — but it reads the break rule with the
  // page names already on the tree only if those rules came first. Any later
  // and every zone opened with a blank page (an empty verso folio "1" before
  // chapter one, a blank recto with a running head before the colophon).
  const css = Deno.readTextFileSync(new URL("./base.css", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const firstBreak = css.indexOf("break-before");
  assert(firstBreak > 0, "expected a break-before rule in base.css");
  for (const zone of ["front", "body", "back"]) {
    const at = css.indexOf(`.zone-${zone} {\n  page: ${zone};`);
    assert(
      at >= 0 && at < firstBreak,
      `.zone-${zone} { page: ${zone} } must precede the first break-before rule`,
    );
  }
});
