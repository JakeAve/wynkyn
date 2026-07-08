import { assertEquals } from "jsr:@std/assert";
import { Text } from "@codemirror/state";
import { toCmDiagnostics } from "./diagnostics.ts";

Deno.test("maps 1-based parser lines to document ranges", () => {
  const doc = Text.of(["line one", "line two!", "three"]);
  const [d] = toCmDiagnostics(doc, [{ line: 2, message: "unclosed block" }]);
  assertEquals(d, {
    from: 9,
    to: 18,
    severity: "warning",
    message: "unclosed block",
  });
});

Deno.test("clamps out-of-range lines instead of throwing", () => {
  const doc = Text.of(["only line"]);
  const mapped = toCmDiagnostics(doc, [
    { line: 99, message: "past the end" },
    { line: 0, message: "before the start" },
  ]);
  assertEquals(mapped.map((d) => [d.from, d.to]), [[0, 9], [0, 9]]);
});
