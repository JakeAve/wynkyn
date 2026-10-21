// metadata/css-generator.ts — Metadata → CSS strings (spec §5.2). Pure, no I/O.
import type { CssProps, ElementStyle, Metadata } from "./types.ts";
import type { FolioPosition, NumberingStyle, RunningEntry } from "./types.ts";

const MATTER_KEYS = new Set([
  "half-title",
  "title-page",
  "copyright",
  "dedication",
  "toc",
  "foreword",
  "preface",
  "introduction",
  "appendix",
  "bibliography",
  "index",
  "colophon",
]);

const PROSE_MATTER = ["foreword", "preface", "introduction"];

// Exported so the web style catalog matches clicks against the same selectors.
export function selectorFor(key: string): string {
  if (key === "body") return ".bml";
  if (key === "em") return ".bml em";
  if (key === "paragraph") return ".bml p";
  if (key === "prose-matter") {
    return PROSE_MATTER.map((t) => `.matter-${t}`).join(", ");
  }
  if (MATTER_KEYS.has(key)) return `.matter-${key}`;
  return `.${key}`;
}

function resolveFontValue(
  value: string,
  fonts: Record<string, string> | undefined,
): string {
  if (fonts && Object.hasOwn(fonts, value)) return `"${fonts[value]}"`;
  return value;
}

function rule(
  selector: string,
  props: CssProps,
  fonts?: Record<string, string>,
): string {
  const decls: string[] = [];
  const pseudo: string[] = [];
  for (const [prop, value] of Object.entries(props)) {
    if (prop === "content" && selector.endsWith(".leader")) {
      // TOC leaders repeat the string many times from base.css; hand it over
      // as a custom property instead of a single ::before content (spec §4.5).
      decls.push(`  --leader: ${JSON.stringify(value)};`);
    } else if (prop === "content") {
      pseudo.push(`  content: ${JSON.stringify(value)};`);
    } else if (prop === "font-family") {
      decls.push(`  font-family: ${resolveFontValue(value, fonts)};`);
    } else {
      decls.push(`  ${prop}: ${value};`);
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

function emitStyle(
  selector: string,
  style: ElementStyle,
  fonts: Record<string, string> | undefined,
  out: string[],
): void {
  const flat: CssProps = {};
  const nested: Array<[string, ElementStyle]> = [];
  for (const [prop, value] of Object.entries(style)) {
    if (typeof value === "string") flat[prop] = value;
    else nested.push([prop, value]);
  }
  if (Object.keys(flat).length) out.push(rule(selector, flat, fonts));
  for (const [sub, subStyle] of nested) {
    // `em` is the emphasis element ({em}, §3.2.7); every other key a class.
    const part = sub === "em" ? "em" : `.${sub}`;
    emitStyle(
      selector.split(", ").map((s) => `${s} ${part}`).join(", "),
      subStyle,
      fonts,
      out,
    );
  }
}

export function generateDomCSS(metadata: Metadata): string {
  const out: string[] = [];
  const fonts = metadata.fonts;
  for (const [key, style] of Object.entries(metadata.elements ?? {})) {
    emitStyle(selectorFor(key), style, fonts, out);
  }
  for (const [cls, props] of Object.entries(metadata.is ?? {})) {
    out.push(rule(`.is-${cls}`, props, fonts));
  }
  return out.join("");
}

export interface ZoneNumbering {
  style: NumberingStyle;
  show: boolean;
}

export interface PageNumberingConfig {
  front: ZoneNumbering;
  body: ZoneNumbering;
  back: ZoneNumbering;
}

// Page zone (named page, page map) → its key under numbering.pages.
const ZONE_KEYS: ReadonlyArray<
  [keyof PageNumberingConfig, "front-matter" | "body" | "back-matter"]
> = [["front", "front-matter"], ["body", "body"], ["back", "back-matter"]];

// What the page map (renderer/folios.js) formats folios from, per zone (§4.7).
export function pageNumberingConfig(metadata: Metadata): PageNumberingConfig {
  const pages = metadata.numbering?.pages;
  return Object.fromEntries(ZONE_KEYS.map(([zone, key]) => [zone, {
    style: pages?.[key]?.style ?? "arabic",
    show: pages?.[key]?.show ?? true,
  }])) as Record<keyof PageNumberingConfig, ZoneNumbering>;
}

// Strings read through --running-off, which the page map sets on pages that
// carry no running head (openers, blanks, display pages; §4.8).
function runningContent(value: string, bookTitle?: string): string {
  const off = (s: string) => `var(--running-off, ${JSON.stringify(s)})`;
  switch (value) {
    case "book-title":
      return off(bookTitle ?? "");
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
// text block edge instead, `gap` away (§4.7, §4.8). Side boxes are untouched.
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

export function generatePagedCSS(
  metadata: Metadata,
  opts: { bookTitle?: string } = {},
): string {
  const out: string[] = [];

  // 1. Page box (§4.3)
  const page = metadata.page;
  if (page) {
    const decls: string[] = [];
    if (page.size) decls.push(`  size: ${page.size};`);
    if (page.margins?.top) decls.push(`  margin-top: ${page.margins.top};`);
    if (page.margins?.bottom) {
      decls.push(`  margin-bottom: ${page.margins.bottom};`);
    }
    if (decls.length) out.push(`@page {\n${decls.join("\n")}\n}\n`);
    const inside = page.margins?.inside;
    const outside = page.margins?.outside;
    if (inside && outside) {
      out.push(
        `@page :right {\n  margin-left: ${inside};\n  margin-right: ${outside};\n}\n`,
      );
      out.push(
        `@page :left {\n  margin-left: ${outside};\n  margin-right: ${inside};\n}\n`,
      );
    }
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
      for (const [side, area] of folioAt) {
        const decls = [`    content: var(--folio);`];
        // Anchoring first, then shared folio styling, then the zone's own
        // `css`: a book's own keys win (§4.7).
        for (
          const [k, v] of Object.entries({
            ...anchorToTextBlock(area, pages?.gap ?? DEFAULT_FOLIO_GAP),
            ...pages?.css,
            ...cfg?.css,
          })
        ) {
          decls.push(
            `    ${k}: ${
              k === "font-family" ? resolveFontValue(v, metadata.fonts) : v
            };`,
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
      const decls = [
        `    content: ${runningContent(entry.content, opts.bookTitle)};`,
      ];
      const props = { ...anchorToTextBlock(entry.area, gap), ...entry };
      for (const [k, v] of Object.entries(props)) {
        if (k === "content" || k === "area") continue;
        decls.push(
          `    ${k}: ${
            k === "font-family" ? resolveFontValue(v, metadata.fonts) : v
          };`,
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
  const usedAreas = new Set<string>(folioAt.map(([, area]) => area));
  for (
    const e of [
      ...(metadata.running?.odd ?? []),
      ...(metadata.running?.even ?? []),
    ]
  ) {
    usedAreas.add(e.area);
  }
  out.push(
    `@page display {\n${
      [...usedAreas].map((a) => `  @${a} {\n    content: none;\n  }`).join("\n")
    }\n}\n`,
  );

  // 4. Footnote placement (§4.10)
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
