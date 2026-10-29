// web/src/text-view_test.ts
import { assertEquals } from "@std/assert";
import { readPrefs } from "./text-view.ts";

Deno.test("old text view prefs load: mono is Source, hide is dropped", () => {
  assertEquals(readPrefs('{"font":"mono","hide":true}'), {
    ...readPrefs(null),
    view: "source",
  });
});
