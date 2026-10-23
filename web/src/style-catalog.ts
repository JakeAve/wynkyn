// web/src/style-catalog.ts — every stylable element (spec §4.5 + page
// numbers + running heads + `is:` classes), how a preview click resolves to
// one, and how entries group into the style panel's book parts and tabs.
// Pure: the DOM adapter lives in preview.ts, so this is unit-tested in Deno.
import { folioAreas, selectorFor } from "../../metadata/css-generator.ts";
import type {
  CssProps,
  FolioPosition,
  Metadata,
  Running,
} from "../../metadata/types.ts";

export interface StyleEntry {
  key: string; // "chapter.title"
  group: string; // <optgroup> label
  label: string; // <option> label
  path: string[]; // where the props object lives in Metadata
  section: "elements" | "is" | "numbering" | "running"; // queueSave key
  selector: string; // rendered CSS selector — space-separated .class tokens
}

// [group, type, sub-elements (empty = flat type)]
const ELEMENTS: Array<[string, string, string[]]> = [
  ["Body text", "body", []],
  ["Body text", "em", []],
  ["Body text", "dropcap", []],
  ["Body text", "footnote", []],
  ["Half title", "half-title", ["title"]],
  ["Title page", "title-page", [
    "title",
    "subtitle",
    "author",
    "edition",
    "epigraph",
    "imprint",
  ]],
  ["Copyright", "copyright", []], // the page: position, shared type
  ["Copyright", "copyright", ["copyright-line", "rights", "isbn", "edition"]],
  ["Dedication", "dedication", []],
  ["Contents", "toc", [
    "title",
    "label",
    "number",
    "subtitle",
    "leader",
    "page",
    "toc-front",
    "toc-part",
    "toc-chapter",
    "toc-heading",
    "toc-back",
    "entry",
  ]],
  ["Foreword / preface / introduction", "prose-matter", ["title"]],
  ["Part", "part", ["title", "number"]],
  ["Chapter", "chapter", ["title", "number"]],
  ["Headings", "heading", []],
  ["Headings", "subheading", []],
  ["Epigraph", "epigraph", ["text", "attribution"]],
  ["Blocks", "break", []],
  ["Blocks", "pullquote", []],
  ["Blocks", "quote", []],
  ["Blocks", "poem", []],
  ["Blocks", "sidebar", []],
  ["Verses", "verses", []],
  ["Verses", "verses", ["number"]],
  ["Columns", "columns", []],
  ["Illustration", "illustration", ["caption"]],
  ["Colophon", "colophon", []],
  ["Appendix", "appendix", ["title"]],
];

function titleCase(s: string): string {
  return s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const LABELS: Record<string, string> = {
  page: "Page number",
  "toc-front": "Front matter rows",
  "toc-part": "Part rows",
  "toc-chapter": "Chapter rows",
  "toc-heading": "Heading rows",
  "toc-back": "Back matter rows",
};

function labelFor(sub: string): string {
  return LABELS[sub] ?? titleCase(sub);
}

const STATIC_CATALOG: StyleEntry[] = ELEMENTS.flatMap(([group, type, subs]) =>
  subs.length
    ? subs.map((sub) => ({
      key: `${type}.${sub}`,
      group,
      label: labelFor(sub),
      path: ["elements", type, sub],
      section: "elements" as const,
      selector: `${selectorFor(type)} .${sub}`,
    }))
    : [{
      key: type,
      group,
      label: group === titleCase(type) ? "Everything" : titleCase(type),
      path: ["elements", type],
      section: "elements" as const,
      selector: selectorFor(type),
    }]
);

// Body paragraphs, matched by tag: the click chain ends each element's
// classes with its tag name.
const PARAGRAPH: StyleEntry = {
  key: "paragraph",
  group: "Body text",
  label: "Paragraph",
  path: ["elements", "paragraph"],
  section: "elements",
  selector: ".bml p",
};

const ZONES = [
  ["front-matter", "front"],
  ["body", "body"],
  ["back-matter", "back"],
] as const;

function pageNumberEntries(metadata: Metadata): StyleEntry[] {
  // The margin boxes a folio sits in (§4.7): outside is two boxes, so a
  // click on either side's is a folio; so is an opener's drop-folio box.
  const pages = metadata.numbering?.pages;
  const boxes = [
    ...folioAreas(pages?.position),
    ...(pages?.openers?.position ? folioAreas(pages.openers.position) : []),
  ].map(([, area]) => `.pagedjs_margin-${area}`);
  return [
    {
      key: "numbering.pages",
      group: "Page numbers",
      label: "All page numbers",
      path: ["numbering", "pages", "css"],
      section: "numbering",
      selector: boxes.join(", "),
    },
    ...ZONES.map(([zone, name]): StyleEntry => ({
      key: `numbering.pages.${zone}`,
      group: "Page numbers",
      label: titleCase(zone),
      path: ["numbering", "pages", zone, "css"],
      section: "numbering",
      selector: boxes.map((b) => `.pagedjs_${name}_page ${b}`).join(", "),
    })),
  ];
}

// The running head sharing a folio's margin box, as "top right", if any.
// Heads are body only and odd pages are recto, so outside is the right box on
// odd and the left on even. Heads are emitted after folios, so the head wins it.
export function folioClash(
  position: FolioPosition,
  running: Running | undefined,
): string | undefined {
  const odd = (running?.odd ?? []).map((e) => e.area);
  const even = (running?.even ?? []).map((e) => e.area);
  for (const [side, area] of folioAreas(position)) {
    const heads = side === ":right" ? odd : side === ":left" ? even : [
      ...odd,
      ...even,
    ];
    if (heads.includes(area)) return area.replace("-", " ");
  }
  return undefined;
}

// Per-level spans inside the contents: part and chapter rows get their own
// number/label/page entries so "Book One" can be small caps while the part
// title is italic (spec §4.5 recipes).
const TOC_NESTED: StyleEntry[] = (["toc-part", "toc-chapter"] as const).flatMap(
  (level) =>
    (["number", "label", "page"] as const).map((sub) => ({
      key: `toc.${level}.${sub}`,
      group: "Contents",
      label: `${level === "toc-part" ? "Part" : "Chapter"} ${
        labelFor(sub).toLowerCase()
      }`,
      path: ["elements", "toc", level, sub],
      section: "elements" as const,
      selector: `.matter-toc .${level} .${sub}`,
    })),
);

// Give each `{is: name}` the manuscript uses an entry, empty if unstyled, so
// it can be picked and styled before it has any CSS. The panel's save drops
// the empty ones again.
export function addIsNames(metadata: Metadata, names: Iterable<string>): void {
  for (const n of names) (metadata.is ??= {})[n] ??= {};
}

export function catalogFor(metadata: Metadata): StyleEntry[] {
  const is = Object.keys(metadata.is ?? {}).map((name): StyleEntry => ({
    key: `is.${name}`,
    group: "Custom (is:)",
    label: name,
    path: ["is", name],
    section: "is",
    selector: `.is-${name}`,
  }));
  return [
    ...STATIC_CATALOG,
    PARAGRAPH,
    ...TOC_NESTED,
    ...pageNumberEntries(metadata),
    ...runningEntries(metadata),
    ...is,
  ];
}

// One entry per margin area the running heads use. They are edited in the
// Running heads part, so the path is the whole `running` section.
function runningEntries(metadata: Metadata): StyleEntry[] {
  const areas = new Set(
    [...(metadata.running?.odd ?? []), ...(metadata.running?.even ?? [])]
      .map((e) => e.area),
  );
  return [...areas].map((area) => ({
    key: `running.${area}`,
    group: "Running heads",
    label: titleCase(area),
    path: ["running"],
    section: "running",
    selector: `.pagedjs_margin-${area}`,
  }));
}

// ---- Style panel: tabs, book parts, routes (spec R1) ----

export type TabId = "page" | "fonts" | "parts" | "publish";

export interface Route {
  tab: TabId;
  part?: string;
  focus?: string;
}

export interface PreviewLink {
  pages(): HTMLElement[]; // the live preview's pages in order; [] until it paginates
  pageCount(): number; // pages().length
  endsWithColophon(): boolean; // the last page is the colophon (pinned last when printed)
  pagesFor(key: string): number;
  highlight(key: string, on: boolean): void;
  reveal(key: string): void;
}

export interface PanelContext {
  meta: Metadata;
  queueSave(key: keyof Metadata): void;
  go(route: Route): void;
  preview: PreviewLink;
  sheetView: HTMLElement; // where the Publish view draws the signature
  // The Publish tab's exports: land pending saves, then run on the server.
  exportPrint(req: ExportRequest): Promise<ExportResult>;
  exportEpub(): Promise<EpubResult>;
  onPages(redraw: () => void): void; // called after each preview render
}

export interface ExportRequest {
  proof: boolean;
  force: boolean; // export despite page-map problems
  pages?: number; // proof page count; a booklet proof needs one
}

export interface EpubResult {
  error?: string; // the export failed outright
  file?: { name: string; url: string }; // set once the .epub was written
  documents?: number; // content documents in reading order
}

export interface ExportResult {
  error?: string; // the export failed outright
  problems: string[]; // refused over these unless forced, or exported with them
  summary?: string; // set once files were written
  files: Array<{ name: string; url: string }>;
}

export interface BookPart {
  id: string;
  name: string;
  group: "furniture" | "front" | "body" | "back" | "custom";
  keys: string[]; // catalog entry keys, in display order
}

// [id, name, group, element types in display order]
const PARTS: Array<[string, string, BookPart["group"], string[]]> = [
  ["folios", "Page numbers", "furniture", ["numbering"]],
  ["heads", "Running heads", "furniture", ["running"]],
  ["half-title", "Half title", "front", ["half-title"]],
  ["title-page", "Title page", "front", ["title-page"]],
  ["copyright", "Copyright", "front", ["copyright"]],
  ["dedication", "Dedication", "front", ["dedication"]],
  ["contents", "Contents", "front", ["toc"]],
  ["prose", "Foreword, preface, introduction", "front", ["prose-matter"]],
  ["body", "Body text", "body", ["body", "paragraph", "em"]],
  ["part", "Part opener", "body", ["part"]],
  ["chapter", "Chapter opener", "body", ["chapter"]],
  ["headings", "Headings", "body", ["heading", "subheading"]],
  ["epigraph", "Epigraph", "body", ["epigraph"]],
  ["blocks", "Quotes, poems and asides", "body", [
    "quote",
    "pullquote",
    "poem",
    "sidebar",
    "verses",
    "columns",
  ]],
  ["dropcaps", "Drop caps and breaks", "body", ["dropcap", "break"]],
  ["illustrations", "Illustrations", "body", ["illustration"]],
  ["footnotes", "Notes", "body", ["footnote"]],
  ["appendix", "Appendix", "back", ["appendix"]],
  ["colophon", "Colophon", "back", ["colophon"]],
];

const typeOf = (key: string) => key.split(".")[0]!;

export function bookParts(metadata: Metadata): BookPart[] {
  const keys = catalogFor(metadata).map((e) => e.key);
  const parts: BookPart[] = PARTS.map(([id, name, group, types]) => ({
    id,
    name,
    group,
    keys: types.flatMap((t) => keys.filter((k) => typeOf(k) === t)),
  }));
  for (const name of Object.keys(metadata.is ?? {})) {
    parts.push({
      id: `is.${name}`,
      name,
      group: "custom",
      keys: [`is.${name}`],
    });
  }
  return parts;
}

// Where a preview pick (or a "Used by" chip) opens in the panel.
export function routeFor(key: string, metadata: Metadata): Route {
  const type = typeOf(key);
  if (type === "numbering") return { tab: "parts", part: "folios" };
  if (type === "running") return { tab: "parts", part: "heads" };
  const part = bookParts(metadata).find((p) => p.keys.includes(key));
  if (!part) return { tab: "parts" };
  if (part.id === "body") {
    const focus = key === "em" ? "emphasis" : "paragraphs";
    return { tab: "parts", part: "body", focus };
  }
  if (part.group === "custom") return { tab: "parts", part: part.id };
  // chapter.number → "number"; a flat type (heading, quote) is its own block.
  return {
    tab: "parts",
    part: part.id,
    focus: key.slice(type.length + 1) || type,
  };
}

// The alias an entry's text is set in: its own font-family, else the nearest
// ancestor entry's, else the body's — so inherited text counts as body.
function aliasOf(
  metadata: Metadata,
  path: string[],
  bodyAlias: string,
): string {
  for (let i = path.length; i > 1; i--) {
    const ff = getProps(metadata, { path: path.slice(0, i) })["font-family"];
    if (ff) return ff;
  }
  return bodyAlias;
}

// Every part, page numbers and running heads set in `alias` (Fonts tab chips).
export function usedBy(
  metadata: Metadata,
  alias: string,
): Array<{ label: string; route: Route }> {
  const catalog = new Map(catalogFor(metadata).map((e) => [e.key, e]));
  const bodyAlias =
    getProps(metadata, { path: ["elements", "body"] })["font-family"] ?? "body";
  const out: Array<{ label: string; route: Route }> = [];
  for (const part of bookParts(metadata)) {
    if (part.group === "furniture") continue; // margin boxes: below
    const uses = part.keys.some((k) =>
      aliasOf(metadata, catalog.get(k)!.path, bodyAlias) === alias
    );
    if (uses) {
      out.push({ label: part.name, route: { tab: "parts", part: part.id } });
    }
  }
  // Margin boxes inherit nothing from the body: only an explicit font counts.
  const pages = pageNumberEntries(metadata).some((e) =>
    getProps(metadata, e)["font-family"] === alias
  );
  if (pages) {
    out.push({
      label: "Page numbers",
      route: routeFor("numbering.pages", metadata),
    });
  }
  const heads = [
    ...(metadata.running?.odd ?? []),
    ...(metadata.running?.even ?? []),
  ]
    .some((e) => e["font-family"] === alias);
  if (heads) {
    out.push({
      label: "Running heads",
      route: routeFor("running", metadata),
    });
  }
  return out;
}

// The change count on a Book parts row: string props set across the part's
// entries, plus the chapter/part numbering keys its opener view edits. Page
// numbers add their position, gap and zone numerals; running heads count each
// entry's keys bar its area, plus the gap. Pass `catalog` (catalogFor keyed
// by key) when counting many parts of one book.
export function setCount(
  metadata: Metadata,
  part: BookPart,
  catalog = new Map(catalogFor(metadata).map((e) => [e.key, e])),
): number {
  if (part.id === "heads") {
    const r = metadata.running;
    return [...(r?.odd ?? []), ...(r?.even ?? [])].reduce(
      (n, e) => n + Object.keys(e).filter((k) => k !== "area").length,
      r?.gap ? 1 : 0,
    );
  }
  let n = 0;
  for (const k of part.keys) {
    const entry = catalog.get(k);
    if (entry) n += Object.keys(getProps(metadata, entry)).length;
  }
  if (part.id === "folios") {
    const p = metadata.numbering?.pages;
    const zones = ZONES.map(([z]) => p?.[z]);
    return n + (p?.position ? 1 : 0) + (p?.gap ? 1 : 0) +
      zones.reduce(
        (m, z) =>
          m + (z?.style !== undefined ? 1 : 0) +
          (z?.show !== undefined ? 1 : 0),
        0,
      );
  }
  const numbering = part.id === "chapter"
    ? metadata.numbering?.chapters
    : part.id === "part"
    ? metadata.numbering?.parts
    : undefined;
  return n + Object.keys(numbering ?? {}).length;
}

// `chain[0]` is the clicked node's classes, `chain[n]` its n-th ancestor's.
// A selector's tokens must appear in order walking outward; the entry whose
// innermost token matches nearest the click wins, so ".chapter .number" beats
// ".chapter" for a click on the number. Multi-selector entries (prose-matter)
// are comma-separated; any alternative may match. An `{is}` class beats all of
// that: wrapping text in one is how the author asks to style it apart.
export function matchKey(
  chain: string[][],
  catalog: StyleEntry[],
): string | null {
  let best: { key: string; is: boolean; depth: number; tokens: number } | null =
    null;
  for (const entry of catalog) {
    const is = entry.section === "is";
    for (const alt of entry.selector.split(", ")) {
      // ".class" tokens match a class, bare ones ("p", "em") a tag name.
      const tokens = alt.trim().split(/\s+/)
        .map((t) => t.startsWith(".") ? t.slice(1) : t).reverse(); // innermost first
      const depth = matchDepth(chain, tokens);
      if (depth === null) continue;
      if (
        !best || (is && !best.is) ||
        (is === best.is &&
          (depth < best.depth ||
            (depth === best.depth && tokens.length > best.tokens)))
      ) {
        best = { key: entry.key, is, depth, tokens: tokens.length };
      }
    }
  }
  return best?.key ?? null;
}

// Depth of the innermost token's match, or null. Descendant combinator: each
// outer token must match some strictly-farther ancestor.
function matchDepth(chain: string[][], tokens: string[]): number | null {
  const first = tokens[0]!;
  for (let d = 0; d < chain.length; d++) {
    if (!chain[d]!.includes(first)) continue;
    let from = d + 1;
    let ok = true;
    for (const t of tokens.slice(1)) {
      const at = chain.findIndex((cls, i) => i >= from && cls.includes(t));
      if (at < 0) {
        ok = false;
        break;
      }
      from = at + 1;
    }
    if (ok) return d;
  }
  return null;
}

// String-valued props at entry.path (object-valued sub-elements are not
// exposed — they are their own catalog entries).
export function getProps(
  metadata: Metadata,
  entry: Pick<StyleEntry, "path">,
): CssProps {
  let node: unknown = metadata;
  for (const p of entry.path) {
    if (!node || typeof node !== "object") return {};
    node = (node as Record<string, unknown>)[p];
  }
  const out: CssProps = {};
  for (
    const [k, v] of Object.entries((node ?? {}) as Record<string, unknown>)
  ) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// The live object at entry.path, created on demand — mutate it, then save.
export function ensureProps(
  metadata: Metadata,
  entry: StyleEntry,
): Record<string, unknown> {
  let node = metadata as unknown as Record<string, unknown>;
  for (const p of entry.path) {
    node = (node[p] ??= {}) as Record<string, unknown>;
  }
  return node;
}

// What an entry's font actually falls back to when it sets none — shown in the
// picker, because "inherit" is misleading here: a margin box (folio, running
// head) is outside the book body and inherits nothing from it, and the body
// itself falls back to base.css's generic serif.
export function inheritedFont(
  metadata: Metadata,
  entry: Pick<StyleEntry, "key" | "path" | "section">,
): string {
  const family = (v: string | undefined) =>
    v ? (metadata.fonts?.[v] ?? v) : undefined;
  if (entry.section === "numbering" || entry.section === "running") {
    return "browser default"; // margin box
  }
  // Nearest ancestor entry that names a font: .toc .toc-part .number → .toc.
  for (let i = entry.path.length - 1; i > 1; i--) {
    const at = family(
      getProps(metadata, { path: entry.path.slice(0, i) })["font-family"],
    );
    if (at) return at;
  }
  if (entry.key === "body") return "serif";
  return family(
    getProps(metadata, { path: ["elements", "body"] })["font-family"],
  ) ?? "serif";
}
