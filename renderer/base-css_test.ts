// base-css_test.ts — structural regression test for base.css's TOC rules.
// Placed beside base.css (not a .ts module, so no import — just a text-based
// structural check), following the repo's X_test.ts-next-to-X convention.
import { assert } from "jsr:@std/assert";

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
