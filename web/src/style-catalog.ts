// web/src/style-catalog.ts — every stylable element (spec §4.5 + page
// numbers + `is:` classes) and how a preview click resolves to one. Pure:
// the DOM adapter lives in preview.ts, so this is unit-tested in Deno.
import { selectorFor } from "../../metadata/css-generator.ts";
import type { CssProps, Metadata } from "../../metadata/types.ts";

export interface StyleEntry {
  key: string; // "chapter.title"
  group: string; // <optgroup> label
  label: string; // <option> label
  path: string[]; // where the props object lives in Metadata
  section: "elements" | "is" | "numbering"; // queueSave key
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

const ZONES: Array<[string, string]> = [["front-matter", "front"], [
  "body",
  "body",
], ["back-matter", "back"]];
const PAGE_NUMBERS: StyleEntry[] = ZONES.map(([zone, name]) => ({
  key: `numbering.pages.${zone}`,
  group: "Page numbers",
  label: titleCase(zone),
  path: ["numbering", "pages", zone, "css"],
  section: "numbering",
  selector: `.pagedjs_${name}_page .pagedjs_margin-bottom-center`,
}));

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

export function catalogFor(metadata: Metadata): StyleEntry[] {
  const is = Object.keys(metadata.is ?? {}).map((name): StyleEntry => ({
    key: `is.${name}`,
    group: "Custom (is:)",
    label: name,
    path: ["is", name],
    section: "is",
    selector: `.is-${name}`,
  }));
  return [...STATIC_CATALOG, ...TOC_NESTED, ...PAGE_NUMBERS, ...is];
}

// `chain[0]` is the clicked node's classes, `chain[n]` its n-th ancestor's.
// A selector's tokens must appear in order walking outward; the entry whose
// innermost token matches nearest the click wins, so ".chapter .number" beats
// ".chapter" for a click on the number. Multi-selector entries (prose-matter)
// are comma-separated; any alternative may match.
export function matchKey(
  chain: string[][],
  catalog: StyleEntry[],
): string | null {
  let best: { key: string; depth: number; tokens: number } | null = null;
  for (const entry of catalog) {
    for (const alt of entry.selector.split(", ")) {
      const tokens = alt.trim().split(/\s+/).map((t) => t.slice(1)).reverse(); // innermost first
      const depth = matchDepth(chain, tokens);
      if (depth === null) continue;
      if (
        !best || depth < best.depth ||
        (depth === best.depth && tokens.length > best.tokens)
      ) {
        best = { key: entry.key, depth, tokens: tokens.length };
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
export function getProps(metadata: Metadata, entry: StyleEntry): CssProps {
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
