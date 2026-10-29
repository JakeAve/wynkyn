// metadata/css-generator.ts — Metadata → CSS strings (spec §5.2). Pure, no I/O.
import type { CssProps, ElementStyle, Metadata } from "./types.ts";
import type { FolioPosition, NumberingStyle, RunningEntry } from "./types.ts";
import { CLASS_NAME_RE, MATTER_TYPES } from "../parser/types.ts";

const PROSE_MATTER = Object.keys(MATTER_TYPES).filter((t) =>
  MATTER_TYPES[t]!.prose
);

// The 16 CSS Paged Media margin boxes, in §4.8's order.
export const MARGIN_AREAS = [
  "top-left-corner",
  "top-left",
  "top-center",
  "top-right",
  "top-right-corner",
  "right-top",
  "right-middle",
  "right-bottom",
  "bottom-right-corner",
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "bottom-left-corner",
  "left-bottom",
  "left-middle",
  "left-top",
] as const;

// metadata.json is hand-editable and books arrive from other people's
// folders, so a key or value is checked before it is written into CSS: one
// that could end its declaration, rule or comment (or the <style> around it)
// is left out, the way a browser drops a declaration it can't parse.
const KEY_RE = /^[a-z][a-z0-9-]*$/; // element and sub-element keys
const PROP_RE = /^-{0,2}[a-z][a-z0-9-]*$/; // property names, -vendor and --custom
const AREAS: ReadonlySet<string> = new Set(MARGIN_AREAS);

function safeValue(v: unknown): v is string {
  return typeof v === "string" && !/[{};<]|\/\*/.test(v) &&
    (v.split('"').length % 2 === 1) && (v.split("'").length % 2 === 1);
}

const safeProp = (k: string, v: unknown): v is string =>
  PROP_RE.test(k) && safeValue(v);

// Exported so the web style catalog matches clicks against the same selectors.
export function selectorFor(key: string): string {
  if (key === "body") return ".bml";
  if (key === "em") return ".bml em";
  if (key === "paragraph") return ".bml p";
  // A note's text: span.note at the page foot, div.note in the endnotes.
  if (key === "footnote") return ".note";
  if (key === "prose-matter") {
    return PROSE_MATTER.map((t) => `.matter-${t}`).join(", ");
  }
  // `epigraph` styles the epigraph block, which a {matter: epigraph} holds.
  if (Object.hasOwn(MATTER_TYPES, key) && key !== "epigraph") {
    return `.matter-${key}`;
  }
  return `.${key}`;
}

// A sub-element under each alternative of `parent`. `sub` is a selector part
// (".title", "em"). Directly under a part or a chapter it is a child: a part
// holds its chapters and a chapter its verses, so `.part .title` would style
// every chapter title in it and `.chapter .number` every verse number.
export function subSelector(parent: string, sub: string): string {
  const child = parent === ".part" || parent === ".chapter";
  return parent.split(", ").map((s) => `${s} ${child ? "> " : ""}${sub}`)
    .join(", ");
}

type Aliases = Pick<Metadata, "fonts" | "colors">;

// A font alias (§4.4) in `font-family`, or a color alias (§4.15) in `color`
// or any `*-color`, becomes what it names; any other value is CSS as written.
function resolve(prop: string, value: string, aliases: Aliases): string {
  const { fonts, colors } = aliases;
  if (prop === "font-family") {
    return fonts && Object.hasOwn(fonts, value)
      ? JSON.stringify(fonts[value])
      : value;
  }
  const color = colors && Object.hasOwn(colors, value)
    ? colors[value]
    : undefined;
  if ((prop === "color" || prop.endsWith("-color")) && safeValue(color)) {
    return color;
  }
  return value;
}

function rule(
  selector: string,
  props: CssProps,
  aliases: Aliases,
): string {
  const decls: string[] = [];
  const pseudo: string[] = [];
  for (const [prop, value] of Object.entries(props)) {
    // `content` is written as a JSON string, so any text is safe in it.
    if (
      prop === "content" ? typeof value !== "string" : !safeProp(prop, value)
    ) {
      continue;
    }
    if (prop === "content" && selector.endsWith(".leader")) {
      // TOC leaders repeat the string many times from base.css; hand it over
      // as a custom property instead of a single ::before content (spec §4.5).
      // Padded so base.css's fixed number of repeats outruns any row: a
      // short unit like ". " would otherwise stop short of the entry.
      const unit = String(value);
      const padded = unit.repeat(Math.ceil(40 / Math.max(unit.length, 1)));
      decls.push(`  --leader: ${JSON.stringify(padded)};`);
    } else if (prop === "content") {
      pseudo.push(`  content: ${JSON.stringify(value)};`);
    } else {
      decls.push(`  ${prop}: ${resolve(prop, value, aliases)};`);
    }
  }
  let out = "";
  if (decls.length) out += `${selector} {\n${decls.join("\n")}\n}\n`;
  if (pseudo.length) {
    const sel = selector.split(", ").map((s) => `${s}::before`).join(", ");
    out += `${sel} {\n${pseudo.join("\n")}\n}\n`;
  }
  return out;
}

/** One emitted DOM rule and the selector it was written for (`::before` and
 * its declarations included in `css`). */
export interface DomRule {
  selector: string;
  css: string;
}

function emitStyle(
  selector: string,
  style: ElementStyle,
  aliases: Aliases,
  out: DomRule[],
): void {
  const flat: CssProps = {};
  const nested: Array<[string, ElementStyle]> = [];
  for (const [prop, value] of Object.entries(style)) {
    if (typeof value === "string") flat[prop] = value;
    else if (KEY_RE.test(prop) && value && typeof value === "object") {
      nested.push([prop, value]);
    }
  }
  if (Object.keys(flat).length) push(out, selector, flat, aliases);
  for (const [sub, subStyle] of nested) {
    // `em` is the emphasis element ({em}, §3.2.7); every other key a class.
    const part = sub === "em" ? "em" : `.${sub}`;
    emitStyle(
      subSelector(selector, part),
      subStyle,
      aliases,
      out,
    );
  }
}

function push(
  out: DomRule[],
  selector: string,
  props: CssProps,
  aliases: Aliases,
): void {
  const css = rule(selector, props, aliases);
  if (css) out.push({ selector, css });
}

/** The book's DOM CSS rule by rule, so a cache can tell which sections a
 * style change reaches (font and color aliases are already resolved). */
export function domRules(metadata: Metadata): DomRule[] {
  const out: DomRule[] = [];
  for (const [key, style] of Object.entries(metadata.elements ?? {})) {
    if (KEY_RE.test(key)) emitStyle(selectorFor(key), style, metadata, out);
  }
  for (const [cls, props] of Object.entries(metadata.is ?? {})) {
    if (CLASS_NAME_RE.test(cls)) push(out, `.is-${cls}`, props, metadata);
  }
  return out;
}

export function generateDomCSS(metadata: Metadata): string {
  return domRules(metadata).map((r) => r.css).join("");
}

export interface ZoneNumbering {
  style: NumberingStyle;
  show: boolean;
}

export interface PageNumberingConfig {
  front: ZoneNumbering;
  body: ZoneNumbering;
  back: ZoneNumbering;
  // Chapter and part openers: `position` is null when their folio sits in
  // the same box as every other page's, so the page map and the CSS agree on
  // when the number moves to the --folio-opener box.
  openers: { show: boolean; position: FolioPosition | null };
}

// Page zone (named page, page map) → its key under numbering.pages.
const ZONE_KEYS: ReadonlyArray<
  ["front" | "body" | "back", "front-matter" | "body" | "back-matter"]
> = [["front", "front-matter"], ["body", "body"], ["back", "back-matter"]];

// What the page map (renderer/folios.js) formats folios from, per zone (§4.7).
export function pageNumberingConfig(metadata: Metadata): PageNumberingConfig {
  const pages = metadata.numbering?.pages;
  const zones = Object.fromEntries(ZONE_KEYS.map(([zone, key]) => [zone, {
    style: pages?.[key]?.style ?? "arabic",
    show: pages?.[key]?.show ?? true,
  }])) as Record<"front" | "body" | "back", ZoneNumbering>;
  const at = folioAreas(pages?.position)[0]![1];
  const openerAt = pages?.openers?.position;
  return {
    ...zones,
    openers: {
      show: pages?.openers?.show ?? true,
      position: openerAt && folioAreas(openerAt)[0]![1] !== at
        ? openerAt
        : null,
    },
  };
}

// Strings read through --running-off, which the page map sets on pages that
// carry no running head (openers, blanks, display pages; §4.8).
function runningContent(value: string): string {
  const off = (s: string) => `var(--running-off, ${JSON.stringify(s)})`;
  switch (value) {
    case "book-title":
      return "var(--running-off, var(--book-title))";
    case "chapter-title":
      return "var(--chapter-title)";
    case "part-title":
      return "var(--part-title)";
    case "page-number":
      return "var(--folio)";
    case "none":
      return "none";
    default:
      return off(value);
  }
}

export const DEFAULT_FOLIO_GAP = "5mm";
export const DEFAULT_HEAD_GAP = "4mm";

// Paged.js sizes a top/bottom margin box to the whole margin and centres its
// content, so a head or folio would float at half the margin. Pin it to the
// text block edge instead, `gap` away whatever its size: a head's baseline, a
// foot's cap height (§4.7, §4.8). base.css trims the line to cap height and
// baseline, so those are the content box's edges. Side boxes are untouched.
function anchorToTextBlock(area: string, gap: string): CssProps {
  if (area.startsWith("top-")) {
    return { "vertical-align": "bottom", "padding-bottom": gap };
  }
  if (area.startsWith("bottom-")) {
    return { "vertical-align": "top", "padding-top": gap };
  }
  return {};
}

// Folio margin box per page side; "outside" mirrors to the fore-edge. A
// position that is not a FolioPosition (hand-edited JSON) is bottom-center.
export function folioAreas(
  position: FolioPosition | undefined,
): Array<[side: "" | ":right" | ":left", area: string]> {
  const [edge, where] = (position ?? "").split("-");
  if (
    (edge !== "top" && edge !== "bottom") ||
    (where !== "center" && where !== "outside")
  ) return [["", "bottom-center"]];
  if (where === "center") return [["", `${edge}-center`]];
  return [[":right", `${edge}-right`], [":left", `${edge}-left`]];
}

export function generatePagedCSS(metadata: Metadata): string {
  const out: string[] = [];

  // 1. Page box (§4.3)
  const page = metadata.page;
  if (page) {
    const decls: string[] = [];
    const ok = (v: string | undefined): v is string => !!v && safeValue(v);
    if (ok(page.size)) decls.push(`  size: ${page.size};`);
    if (ok(page.margins?.top)) {
      decls.push(`  margin-top: ${page.margins.top};`);
    }
    if (ok(page.margins?.bottom)) {
      decls.push(`  margin-bottom: ${page.margins.bottom};`);
    }
    if (decls.length) out.push(`@page {\n${decls.join("\n")}\n}\n`);
    const inside = page.margins?.inside;
    const outside = page.margins?.outside;
    if (ok(inside) && ok(outside)) {
      out.push(
        `@page :right {\n  margin-left: ${inside};\n  margin-right: ${outside};\n}\n`,
      );
      out.push(
        `@page :left {\n  margin-left: ${outside};\n  margin-right: ${inside};\n}\n`,
      );
    }
  }

  // 1b. Margin boxes sit outside the book body but set in its type and ink:
  // every `font-*` key of `body`, and its `color` (§4.7, §4.8). The rules
  // below, more specific and later, let a folio's or head's own keys win.
  const type = Object.entries(metadata.elements?.body ?? {}).filter((
    e,
  ): e is [string, string] =>
    (e[0].startsWith("font-") || e[0] === "color") && safeProp(e[0], e[1])
  );
  if (type.length) {
    out.push(
      `.pagedjs_margin {\n${
        type.map(([k, v]) => `  ${k}: ${resolve(k, v, metadata)};`).join("\n")
      }\n}\n`,
    );
  }

  // 2. Page numbers per zone (§4.7). The folio text is in --folio, set on each
  // page by the page map (renderer/folios.js); the zone → named-page mapping
  // is in base.css.
  const pages = metadata.numbering?.pages;
  const numbering = pageNumberingConfig(metadata);
  const folioAt = folioAreas(pages?.position);
  for (const [name, key] of ZONE_KEYS) {
    const cfg = pages?.[key];
    const { style, show } = numbering[name];
    if (show && style !== "none") {
      // Openers with their own position read --folio-opener, which the page
      // map fills on an opener page and blanks everywhere else (and blanks
      // --folio on the opener), so no page shows two numbers.
      const boxes = [
        ...folioAt.map((b) => [...b, "--folio"] as const),
        ...(numbering.openers.position
          ? folioAreas(numbering.openers.position).map((b) =>
            [...b, "--folio-opener"] as const
          )
          : []),
      ];
      for (const [side, area, variable] of boxes) {
        const decls = [`    content: var(${variable});`];
        // Anchoring first, then shared folio styling, then the zone's own
        // `css`: a book's own keys win (§4.7).
        for (
          const [k, v] of Object.entries({
            ...anchorToTextBlock(area, pages?.gap ?? DEFAULT_FOLIO_GAP),
            ...pages?.css,
            ...cfg?.css,
          })
        ) {
          if (!safeProp(k, v)) continue;
          decls.push(
            `    ${k}: ${resolve(k, v, metadata)};`,
          );
        }
        out.push(
          `@page ${name}${side} {\n  @${area} {\n${decls.join("\n")}\n  }\n}\n`,
        );
      }
    }
  }

  // 3. Running headers (§4.8) — body pages only, odd pages are recto (:right).
  // The titles come from --chapter-title / --part-title (page map), which are
  // empty outside the body.
  const emitEntries = (
    side: "body:right" | "body:left",
    entries: RunningEntry[] | undefined,
  ) => {
    const gap = metadata.running?.gap ?? DEFAULT_HEAD_GAP;
    for (const entry of entries ?? []) {
      if (!AREAS.has(entry.area) || typeof entry.content !== "string") continue;
      const decls = [
        `    content: ${runningContent(entry.content)};`,
      ];
      const props = { ...anchorToTextBlock(entry.area, gap), ...entry };
      for (const [k, v] of Object.entries(props)) {
        if (k === "content" || k === "area" || !safeProp(k, v)) continue;
        decls.push(
          `    ${k}: ${resolve(k, v, metadata)};`,
        );
      }
      out.push(
        `@page ${side} {\n  @${entry.area} {\n${decls.join("\n")}\n  }\n}\n`,
      );
    }
  };
  emitEntries("body:right", metadata.running?.odd);
  emitEntries("body:left", metadata.running?.even);
  // Display matter (half-title, title page, …) sits on the named page
  // "display" (base.css) and carries no running head or folio: blank every
  // margin box the running/page-number rules above populate.
  const usedAreas = new Set<string>([
    ...folioAt,
    ...(numbering.openers.position
      ? folioAreas(numbering.openers.position)
      : []),
  ].map(([, area]) => area));
  for (
    const e of [
      ...(metadata.running?.odd ?? []),
      ...(metadata.running?.even ?? []),
    ]
  ) {
    if (AREAS.has(e.area)) usedAreas.add(e.area);
  }
  out.push(
    `@page display {\n${
      [...usedAreas].map((a) => `  @${a} {\n    content: none;\n  }`).join("\n")
    }\n}\n`,
  );

  // 4. Footnote placement (§4.9)
  if (metadata.notes?.placement === "footnote") {
    out.push(`.note { float: footnote; }\n`);
  }

  return out.join("");
}

export function generateFontLinks(metadata: Metadata): string {
  const families = Object.values(metadata.fonts ?? {});
  if (!families.length) return "";
  const params = families
    .map((f) =>
      `family=${
        encodeURIComponent(f).replace(/%20/g, "+")
      }:ital,wght@0,400;0,700;1,400;1,700`
    )
    .join("&");
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${params}&display=swap">`,
  ].join("\n");
}
