// metadata/themes_test.ts
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { applyTheme, currentTheme, themeLook, THEMES } from "./themes.ts";
import { FONT_CATALOG } from "./fonts-catalog.ts";
import { safeName } from "../server/editions.ts";
import type { Metadata } from "./types.ts";

// A book with something in every key a theme must leave alone.
const BOOK: Metadata & { custom: unknown } = {
  spec: "0.6",
  name: "Standard",
  language: "es",
  page: { size: "a5", margins: { top: "20mm" }, sheet: "letter" },
  fonts: { body: "Lora", mono: "Courier Prime" },
  elements: {
    body: { "font-size": "12pt" },
    letter: { "font-family": "mono" },
  },
  is: { letter: { "font-style": "italic" } },
  numbering: {
    chapters: { style: "alpha-lower", show: false, prefix: "Ch. " },
    parts: { show: false },
    pages: {
      position: "top-center",
      gap: "9mm",
      openers: { show: false, position: "top-center" },
      "front-matter": { style: "arabic", show: false },
      body: { style: "roman-lower", show: true, css: { color: "red" } },
    },
  },
  running: { odd: [{ content: "none", area: "top-center" }] },
  notes: { placement: "footnote" },
  toc: { headings: true },
  ebook: { identifier: "urn:isbn:1" },
  custom: { anything: [1, 2] },
};

const shows = (m: Metadata) => {
  const p = m.numbering?.pages;
  return [
    m.numbering?.chapters?.show,
    m.numbering?.parts?.show,
    p?.openers?.show,
    p?.["front-matter"]?.show,
    p?.body?.show,
    p?.["back-matter"]?.show,
  ];
};

const owned = (m: Metadata) => ({
  fonts: m.fonts,
  elements: m.elements,
  numbering: m.numbering,
  running: m.running,
});

Deno.test("applyTheme never changes the keys a theme does not own", () => {
  const before = structuredClone(BOOK);
  for (const t of THEMES) {
    const out = applyTheme(BOOK, t.slug) as typeof BOOK;
    for (
      const k of [
        "spec",
        "name",
        "language",
        "page",
        "is",
        "notes",
        "toc",
        "ebook",
        "custom",
      ] as const
    ) {
      assertEquals(out[k], BOOK[k], `${t.slug}: ${k}`);
    }
    assertEquals(shows(out), shows(BOOK), `${t.slug}: show`);
    assertEquals(out.fonts?.mono, "Courier Prime", `${t.slug}: own alias`);
    assertEquals(out.elements?.letter, BOOK.elements?.letter, t.slug);
    assertEquals(out.numbering?.pages?.body?.css, { color: "red" }, t.slug);
  }
  assertEquals(BOOK, before, "input not mutated");
});

Deno.test("applyTheme: Caslon then House equals House alone on the owned keys", () => {
  const caslon = applyTheme(BOOK, "caslon");
  assertNotEquals(owned(caslon), owned(applyTheme(BOOK, "house")));
  assertEquals(
    owned(applyTheme(caslon, "house")),
    owned(applyTheme(BOOK, "house")),
  );
  // The folio goes back to the foot: House has no position, so none is left.
  assertEquals(caslon.numbering?.pages?.position, "top-outside");
  assertEquals(
    applyTheme(caslon, "house").numbering?.pages?.position,
    undefined,
  );
});

Deno.test("applyTheme writes the look: elements wholesale, running replaced", () => {
  const out = applyTheme(BOOK, "caslon");
  const look = themeLook("caslon");
  assertEquals(out.elements?.body, look.elements.body);
  assertEquals(out.running, look.running);
  assertEquals(out.fonts?.body, "Libre Caslon Text");
  assertEquals(out.numbering?.chapters?.suffix, ".");
  assertEquals(out.numbering?.pages?.openers, {
    show: false,
    position: "bottom-center",
  });
});

Deno.test("themeLook: House is the template's look", async () => {
  const template = JSON.parse(
    await Deno.readTextFile(
      new URL("../templates/metadata.json", import.meta.url),
    ),
  );
  const house = themeLook("house");
  for (const k of ["fonts", "elements", "numbering", "running"] as const) {
    assertEquals(house[k], template[k], k);
  }
});

Deno.test("unknown slugs throw", () => {
  assertThrows(() => themeLook("nope"));
  assertThrows(() => applyTheme({}, "nope"));
});

Deno.test("every theme's families are in the font catalog", () => {
  const families = new Set(FONT_CATALOG.map(([f]) => f));
  for (const t of THEMES) {
    for (const f of Object.values(themeLook(t.slug).fonts)) {
      assert(families.has(f), `${t.slug}: ${f}`);
    }
  }
});

Deno.test("theme slugs are unique and safe as edition slugs", () => {
  const slugs = THEMES.map((t) => t.slug);
  assertEquals(new Set(slugs).size, slugs.length);
  for (const s of slugs) assert(safeName(s), s);
  const names = THEMES.map((t) => t.name);
  assertEquals(names, names.toSorted((a, b) => a.localeCompare(b)));
});

Deno.test("currentTheme names the theme a book matches, null once edited", async () => {
  const house: Metadata = JSON.parse(
    await Deno.readTextFile(
      new URL("../templates/metadata.json", import.meta.url),
    ),
  );
  assertEquals(currentTheme(house), "house");
  assertEquals(currentTheme(applyTheme(house, "caslon")), "caslon");
  const edited = applyTheme(house, "caslon");
  edited.fonts = { ...edited.fonts, body: "Lora" };
  assertEquals(currentTheme(edited), null);
});
