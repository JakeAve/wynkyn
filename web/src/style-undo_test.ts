import { assertEquals } from "@std/assert";
import type { Metadata } from "../../metadata/types.ts";
import { StyleUndo } from "./style-undo.ts";

Deno.test("style undo: steps, grouping, redo and what disk holds", () => {
  const u = new StyleUndo();
  u.reset({ fonts: { body: "A" } } as Metadata);
  let meta = { fonts: { body: "B" } } as Metadata;

  u.record({ fonts: { body: "B" } }, "fonts", 0);
  u.record({ fonts: { body: "C" } }, "fonts", 500); // same step
  u.record({ colors: { ink: "red" } }, "colors", 600);
  u.record({ colors: { ink: "red" } }, "colors", 5000); // no change, no step

  let s = u.undo(meta)!;
  assertEquals<unknown>(s.sections, { colors: null });
  assertEquals(s.view, "colors");
  meta = s.metadata;
  s = u.undo(meta)!;
  assertEquals(s.sections, { fonts: { body: "A" } });
  assertEquals(s.metadata.fonts, { body: "A" });
  assertEquals("colors" in s.metadata, false);
  assertEquals(u.undo(s.metadata), null);

  s = u.redo(s.metadata)!;
  assertEquals(s.sections, { fonts: { body: "C" } });
  // After an undo or redo the next edit is its own step, and drops redo.
  u.record({ fonts: { body: "D" } }, "fonts", 700);
  assertEquals(u.canRedo(), false);
  assertEquals(u.undo(s.metadata)!.sections, { fonts: { body: "C" } });

  u.reset({} as Metadata);
  assertEquals(u.canUndo(), false);
});
