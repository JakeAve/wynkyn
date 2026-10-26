import { assert, assertEquals } from "@std/assert";
import type { PageEntry } from "../../renderer/page-map-types.ts";
import {
  endsMidWord,
  groupLines,
  type InspectFacts,
  reasonsFor,
} from "./inspect-facts.ts";

const page = (over: Partial<PageEntry> = {}): PageEntry => ({
  index: 4,
  zone: "body",
  display: false,
  blank: false,
  empty: false,
  opener: false,
  head: true,
  folio: 5,
  folioText: "5",
  refText: "5",
  chapterTitle: "The Bell",
  partTitle: "",
  anchors: [],
  ...over,
});

const facts = (over: Partial<InspectFacts> = {}): InspectFacts => ({
  kind: "block",
  label: "Paragraph",
  page: page(),
  firstOnPage: false,
  breakBefore: "auto",
  splitFrom: false,
  continuesOn: null,
  textAlignLast: "auto",
  hyphens: "auto",
  line: null,
  ref: null,
  furniture: null,
  nextOpens: null,
  ...over,
});

const texts = (f: InspectFacts) => reasonsFor(f).map((r) => r.text).join("\n");
const has = (f: InspectFacts, s: string) =>
  assert(texts(f).includes(s), `${JSON.stringify(s)} in\n${texts(f)}`);

Deno.test("reasonsFor: a chapter opener starts a new page or a right-hand one", () => {
  const opener = { page: page({ opener: true, head: false }) };
  const r = reasonsFor(
    facts({
      ...opener,
      label: "Chapter title",
      firstOnPage: true,
      breakBefore: "page",
    }),
  );
  assertEquals(r[0], {
    text: "Starts a new page",
    source: "Book default · break-before: page",
  });
  has(
    facts({ ...opener, firstOnPage: true, breakBefore: "right" }),
    "right-hand page",
  );
});

Deno.test("reasonsFor: a split paragraph continues, its last line stretched", () => {
  has(
    facts({ firstOnPage: true, splitFrom: true }),
    "Continues from the previous page",
  );
  const f = facts({ continuesOn: "6", textAlignLast: "justify" });
  has(f, "Continues on page 6");
  has(f, "Last line stretched");
  assert(!texts(facts({ continuesOn: "6" })).includes("stretched"));
});

Deno.test("reasonsFor: dropped furniture explains itself as a ghost", () => {
  const opener = page({ opener: true, head: false, folioText: "" });
  const head = reasonsFor(
    facts({ kind: "ghost", furniture: "head", page: opener }),
  );
  assertEquals(head, [{
    text: "Not printed: this page opens a chapter",
    source: "Page map",
  }]);
  has(
    facts({ kind: "ghost", furniture: "folio", page: opener }),
    "Page number dropped on chapter openings",
  );
  has(
    facts({ kind: "ghost", furniture: "head", page: page({ display: true }) }),
    "Not printed: display page",
  );
});

Deno.test("reasonsFor: a cross-reference is filled in from the page map", () => {
  const r = reasonsFor(
    facts({ kind: "span", ref: { id: "bell", refText: "12" } }),
  );
  assertEquals(r.at(-1)?.source, "Page map");
  assert(r.at(-1)?.text.includes("page 12"));
});

Deno.test("reasonsFor: the space on a short page", () => {
  has(
    facts({ kind: "space", nextOpens: "The Ferry" }),
    "“The Ferry” starts a new page",
  );
  has(facts({ kind: "space" }), "next block is kept whole");
});

Deno.test("reasonsFor: printed furniture and the first block on a full page", () => {
  has(facts({ kind: "furniture", furniture: "head" }), "Running head");
  has(
    facts({
      kind: "furniture",
      furniture: "folio",
      page: page({ zone: "front" }),
    }),
    "Front pages use their own numbering",
  );
  has(facts({ firstOnPage: true }), "First on the page");
});

Deno.test("groupLines + endsMidWord: three lines, the second hyphenated", () => {
  // Line 2 is two rects (a span inside it); the third rect shares its centre.
  const rects = [
    { top: 40, bottom: 52, left: 10, right: 200 },
    { top: 20, bottom: 32, left: 10, right: 200 },
    { top: 30.5, bottom: 42.5, left: 10, right: 90 },
    { top: 30, bottom: 42, left: 90, right: 198 },
  ];
  const lines = groupLines(rects);
  assertEquals(lines, [
    { top: 20, bottom: 32, left: 10, right: 200 },
    { top: 30, bottom: 42.5, left: 10, right: 198 },
    { top: 40, bottom: 52, left: 10, right: 200 },
  ]);
  const text = ["The bell rang ", "over the wa", "ter at dusk."];
  const hyphenated = text.map((t, i) =>
    i + 1 < text.length && endsMidWord(t, text[i + 1]!)
  );
  assertEquals(hyphenated, [false, true, false]);
  has(
    facts({ kind: "line", line: { n: 2, of: 3, hyphenated: true } }),
    "Breaks the word with a hyphen",
  );
});
