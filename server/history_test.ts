import { assert, assertEquals } from "@std/assert";
import type { BookStore } from "./store.ts";
import { memoryStore } from "../testing/memory-store.ts";
import {
  listVersions,
  restore,
  snapshot,
  thin,
  type Version,
  versionStore,
} from "./history.ts";

async function book() {
  const s = memoryStore();
  await s.write("b/manuscript.md", "{chapter: one}\n\nHello.\n");
  await s.write("b/metadata.json", '{"a":1}');
  await s.write("b/notes.txt", "not snapshotted");
  return s;
}
const objects = (s: BookStore) => s.listDir("b/.history/objects");

Deno.test("unchanged book snapshots to null; styles-only change adds one object", async () => {
  const base = await book();
  let made = 0;
  const s: BookStore = {
    ...base,
    create(path, data) {
      if (path.includes("/.history/objects/")) made++;
      return base.create(path, data);
    },
  };
  const t = new Date("2026-10-23T12:00:00Z");
  const v1 = await snapshot(s, "b", "open", { now: t });
  assert(v1);
  assertEquals(Object.keys(v1.files), ["manuscript.md", "metadata.json"]);
  assertEquals(await snapshot(s, "b", "idle", { now: t }), null);
  const before = [(await objects(s)).length, made];
  await s.write("b/metadata.json", '{"a":2}');
  const v2 = await snapshot(s, "b", "idle", { now: t });
  assert(v2);
  assertEquals(v2.id, "2026-10-23T12-00-00.000Z-2");
  assertEquals([(await objects(s)).length, made], [
    before[0]! + 1,
    before[1]! + 1,
  ]);
  assertEquals(v2.changes, {
    text: false,
    chapters: [],
    images: false,
    editions: [null],
  });
  // a named snapshot of an unchanged book names the latest
  const named = await snapshot(s, "b", "named", { name: "Draft", now: t });
  assertEquals(named?.id, v2.id);
  assertEquals((await listVersions(s, "b"))[0]?.name, "Draft");
  // and a named one again keeps that name, beside a new named version
  const twin = await snapshot(s, "b", "named", { name: "Final", now: t });
  assertEquals(
    (await listVersions(s, "b")).slice(0, 2).map((v) => [v.id, v.name]),
    [[twin!.id, "Final"], [v2.id, "Draft"]],
  );
  // overrides stand in for an unsaved buffer
  const v3 = await snapshot(s, "b", "before-reload", {
    overrides: { "manuscript.md": "{chapter: one}\n\nHello there.\n" },
    now: t,
  });
  assertEquals(v3?.changes.chapters, ["one"]);
  const vs = versionStore(s, "b", v3!);
  assertEquals(
    await vs.readText("b/manuscript.md"),
    "{chapter: one}\n\nHello there.\n",
  );
});

Deno.test("restore text leaves metadata; all removes a later edition", async () => {
  const s = await book();
  const v1 = (await snapshot(s, "b", "open"))!;
  await s.write("b/manuscript.md", "{chapter: one}\n\nChanged.\n");
  await s.write("b/metadata.json", '{"a":9}');
  await s.create("b/editions/small.json", "{}");
  assertEquals(await restore(s, "b", v1, "text"), ["b/manuscript.md"]);
  assertEquals(await s.readText("b/metadata.json"), '{"a":9}');
  assertEquals(await restore(s, "b", v1, "all"), [
    "b/editions/small.json",
    "b/metadata.json",
  ]);
  assertEquals(await s.exists("b/editions/small.json"), false);
  assertEquals(await s.readText("b/notes.txt"), "not snapshotted");
});

Deno.test("thin keeps recent, one per bucket, and every named version", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const v = (at: string, name?: string): Version => ({
    id: at.replaceAll(":", "-"),
    at,
    reason: "idle",
    ...(name ? { name } : {}),
    files: {},
    changes: { text: false, chapters: [], images: false, editions: [] },
  });
  const drop = thin([
    v("2026-10-23T11:00:00.000Z"),
    v("2026-10-23T10:00:00.000Z"), // < 24 h: both kept
    v("2026-10-20T09:50:00.000Z"),
    v("2026-10-20T09:10:00.000Z"), // same hour: dropped
    v("2026-10-20T09:05:00.000Z", "Kept"),
    v("2026-10-01T20:00:00.000Z"),
    v("2026-10-01T08:00:00.000Z"), // same day: dropped
    v("2026-08-05T08:00:00.000Z"), // Wednesday
    v("2026-08-03T08:00:00.000Z"), // Monday, same ISO week: dropped
    v("2026-08-02T08:00:00.000Z"), // Sunday, previous week
  ], now);
  assertEquals(drop.sort(), [
    "2026-08-03T08-00-00.000Z",
    "2026-10-01T08-00-00.000Z",
    "2026-10-20T09-10-00.000Z",
  ]);
});
