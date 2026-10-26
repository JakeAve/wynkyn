import { assertEquals } from "@std/assert";
import { scopeSelector } from "./scope-css.ts";

Deno.test("scopeSelector prefixes each selector, not commas inside one", () => {
  const s = '[data-scope="r1"]';
  assertEquals(
    scopeSelector(
      '.bml p, :where(.bml .toc, .x) a, [data-x="a,b"]::after',
      s,
    ),
    `${s} .bml p, ${s} :where(.bml .toc, .x) a, ${s} [data-x="a,b"]::after`,
  );
  // The page's own variables land on the render's root.
  assertEquals(scopeSelector(":root", s), s);
  assertEquals(scopeSelector("html body .x", s), `${s} body .x`);
  assertEquals(
    scopeSelector(".rooted, bodyish", s),
    `${s} .rooted, ${s} bodyish`,
  );
});
