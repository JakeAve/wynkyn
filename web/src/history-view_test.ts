import { assert, assertEquals } from "@std/assert";
import type { Version } from "../../server/history.ts";
import {
  chaptersLabel,
  dayLabel,
  groupVersions,
  reasonLabel,
  rowLabel,
  styleGroups,
  timeLabel,
} from "./history-view.ts";

const NOW = new Date(2026, 9, 24, 16, 0); // Sat 24 Oct 2026, 4 pm local

function v(
  at: Date,
  reason: Version["reason"] = "idle",
  changes: Partial<Version["changes"]> = {},
  name?: string,
): Version {
  return {
    id: at.toISOString(),
    at: at.toISOString(),
    reason,
    ...(name !== undefined ? { name } : {}),
    files: {},
    changes: {
      text: true,
      chapters: ["one"],
      images: false,
      editions: [],
      ...changes,
    },
  };
}

const ids = (items: unknown[]) =>
  items.map((i) =>
    "fold" in (i as object)
      ? `fold:${(i as { fold: Version[] }).fold.length}`
      : (i as Version).id
  );

Deno.test("day labels and times", () => {
  assertEquals(dayLabel(new Date(2026, 9, 24, 0, 5), NOW), "Today");
  assertEquals(dayLabel(new Date(2026, 9, 23, 23, 59), NOW), "Yesterday");
  assertEquals(dayLabel(new Date(2026, 9, 20, 9), NOW), "Tue 20 Oct");
  assertEquals(dayLabel(new Date(2025, 0, 2, 9), NOW), "Thu 2 Jan 2025");
  assertEquals(timeLabel(new Date(2026, 9, 24, 15, 42)), "3:42 pm");
  assertEquals(timeLabel(new Date(2026, 9, 24, 0, 5)), "12:05 am");
});

Deno.test("groups by day across midnight", () => {
  const a = v(new Date(2026, 9, 24, 0, 1));
  const b = v(new Date(2026, 9, 23, 23, 59));
  const days = groupVersions([a, b], NOW, null, "all");
  assertEquals(days.map((d) => d.label), ["Today", "Yesterday"]);
  assertEquals(ids(days[0]!.items), [a.id]);
  assertEquals(ids(days[1]!.items), [b.id]);
});

Deno.test("folds idle runs beyond two on older days, not today", () => {
  const y = (h: number, r: Version["reason"] = "idle", name?: string) =>
    v(new Date(2026, 9, 23, h), r, {}, name);
  const run = [y(20), y(19, "max"), y(18), y(17), y(16)];
  const named = y(15, "idle", "Sent to printer");
  const tail = [y(14), y(13), y(12)];
  const today = [10, 11, 12, 13].map((m) => v(new Date(2026, 9, 24, 9, m)));
  const days = groupVersions(
    [...today, ...run, named, ...tail],
    NOW,
    null,
    "all",
  );
  assertEquals(days[0]!.items.length, 4); // today never folds
  assertEquals(ids(days[1]!.items), [
    run[0]!.id,
    run[1]!.id,
    "fold:3",
    named.id,
    tail[0]!.id,
    tail[1]!.id,
    "fold:1",
  ]);
});

Deno.test("This edition hides another edition's style-only versions", () => {
  const gift = v(new Date(2026, 9, 24, 9), "idle", {
    text: false,
    chapters: [],
    editions: ["gift"],
  });
  const mine = v(new Date(2026, 9, 24, 8), "idle", {
    text: false,
    chapters: [],
    editions: [null],
  });
  const openNoop = v(new Date(2026, 9, 24, 7), "open", {
    text: false,
    chapters: [],
  });
  const all = [gift, mine, openNoop];
  assertEquals(ids(groupVersions(all, NOW, null, "edition")[0]!.items), [
    mine.id,
  ]);
  assertEquals(ids(groupVersions(all, NOW, null, "all")[0]!.items), [
    gift.id,
    mine.id,
  ]);
  assertEquals(ids(groupVersions(all, NOW, "gift", "edition")[0]!.items), [
    gift.id,
  ]);
});

Deno.test("row labels", () => {
  const at = new Date(2026, 9, 24, 9);
  assertEquals(
    rowLabel(v(at, "idle", { chapters: ["three", "four"] }), null),
    { head: "Text", detail: "Chapters three, four" },
  );
  assertEquals(
    rowLabel(v(at, "idle", { text: false, editions: [null] }), null, {
      styleParts: new Map([[null, ["Chapter title", "Body text"]]]),
    }),
    { head: "Styles", detail: "Chapter title, Body text" },
  );
  assertEquals(
    rowLabel(v(at, "idle", { text: false, editions: ["gift"] }), null, {
      styleParts: new Map([["gift", ["Page setup"]]]),
    }),
    { head: "Gift edition", detail: "Page setup" },
  );
  assertEquals(
    rowLabel(v(at, "named", { editions: [null] }, "Sent to printer"), null),
    { head: "Sent to printer", detail: "Text · Styles" },
  );
  assertEquals(
    chaptersLabel(["Front matter", "one"]),
    "Front matter, Chapter one",
  );
});

Deno.test("an open shows its reason only when something changed", () => {
  const at = new Date(2026, 9, 24, 9);
  assert(reasonLabel(v(at, "open")) !== "");
  assertEquals(reasonLabel(v(at, "open", { text: false, chapters: [] })), "");
  assertEquals(reasonLabel(v(at, "idle")), "");
});

Deno.test("style rows use part and property words", () => {
  const groups = styleGroups(
    { elements: { chapter: { title: { "font-size": "18pt" } } } },
    {
      elements: { chapter: { title: { "font-size": "22pt" } } },
      page: { size: "a5" },
    },
  );
  assertEquals([...groups], [
    ["Chapter title", [{ prop: "Size", from: "18pt", to: "22pt" }]],
    ["Page setup", [{ prop: "Size", from: "unset", to: "a5" }]],
  ]);
});
