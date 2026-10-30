import { assertEquals } from "@std/assert";
import { Transaction } from "@codemirror/state";
import { reloadSpec } from "./editor.ts";

Deno.test("a reload swaps only what differs, off the undo history", () => {
  for (
    const [old, text, change] of [
      ["a cold day", "a warm day", { from: 2, to: 6, insert: "warm" }],
      ["aa", "aaa", { from: 2, to: 2, insert: "a" }],
      ["abc", "", { from: 0, to: 3, insert: "" }],
    ] as const
  ) {
    const spec = reloadSpec(old, text)!;
    assertEquals(spec.changes, change, `${old} → ${text}`);
    assertEquals(
      [spec.annotations].flat()[0]!.type,
      Transaction.addToHistory,
    );
  }
  assertEquals(reloadSpec("same", "same"), null);
});
