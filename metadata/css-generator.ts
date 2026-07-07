// metadata/css-generator.ts — Metadata → CSS strings (spec §5.2). Pure, no I/O.
import type { CssProps, Metadata } from "./types.ts";
import type { PageNumbering, RunningEntry } from "./types.ts";

const MATTER_KEYS = new Set([
  "half-title", "title-page", "copyright", "dedication", "toc",
  "foreword", "preface", "introduction", "appendix", "bibliography",
  "index", "colophon",
]);

const PROSE_MATTER = ["foreword", "preface", "introduction"];

function selectorFor(key: string): string {
  if (key === "body") return ".bml";
  if (key === "em") return ".bml em";
  if (key === "prose-matter") return PROSE_MATTER.map((t) => `.matter-${t}`).join(", ");
  if (MATTER_KEYS.has(key)) return `.matter-${key}`;
  return `.${key}`;
}

function resolveFontValue(value: string, fonts: Record<string, string> | undefined): string {
  if (fonts && Object.hasOwn(fonts, value)) return `"${fonts[value]}"`;
  return value;
}

function rule(selector: string, props: CssProps, fonts?: Record<string, string>): string {
  const decls: string[] = [];
  const pseudo: string[] = [];
  for (const [prop, value] of Object.entries(props)) {
    if (prop === "content") {
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

export function generateDomCSS(metadata: Metadata): string {
  const out: string[] = [];
  const fonts = metadata.fonts;
  for (const [key, style] of Object.entries(metadata.elements ?? {})) {
    const base = selectorFor(key);
    const flat: CssProps = {};
    const subRules: string[] = [];
    for (const [prop, value] of Object.entries(style)) {
      if (typeof value === "string") {
        flat[prop] = value;
      } else {
        const sub = base.split(", ").map((s) => `${s} .${prop}`).join(", ");
        const r = rule(sub, value, fonts);
        if (r) subRules.push(r);
      }
    }
    if (Object.keys(flat).length) out.push(rule(base, flat, fonts));
    out.push(...subRules);
  }
  for (const [cls, props] of Object.entries(metadata.is ?? {})) {
    out.push(rule(`.is-${cls}`, props, fonts));
  }
  return out.join("");
}

const NUM_STYLE: Record<string, string> = {
  "arabic": "decimal",
  "roman-upper": "upper-roman",
  "roman-lower": "lower-roman",
  "alpha-upper": "upper-alpha",
  "alpha-lower": "lower-alpha",
};

function runningContent(value: string, bookTitle?: string): string {
  switch (value) {
    case "book-title":
      return JSON.stringify(bookTitle ?? "");
    case "chapter-title":
      return "string(chapter-title)";
    case "part-title":
      return "string(part-title)";
    case "page-number":
      return "counter(page)";
    case "none":
      return "none";
    default:
      return JSON.stringify(value);
  }
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
    if (page.margins?.bottom) decls.push(`  margin-bottom: ${page.margins.bottom};`);
    if (decls.length) out.push(`@page {\n${decls.join("\n")}\n}\n`);
    const inside = page.margins?.inside;
    const outside = page.margins?.outside;
    if (inside && outside) {
      out.push(`@page :right {\n  margin-left: ${inside};\n  margin-right: ${outside};\n}\n`);
      out.push(`@page :left {\n  margin-left: ${outside};\n  margin-right: ${inside};\n}\n`);
    }
  }

  // 2. Zone-named pages + page numbers (§4.7)
  const pages = metadata.numbering?.pages;
  const zones: Array<[string, string, PageNumbering | undefined]> = [
    ["zone-front", "front", pages?.["front-matter"]],
    ["zone-body", "body", pages?.body],
    ["zone-back", "back", pages?.["back-matter"]],
  ];
  for (const [cls, name, cfg] of zones) {
    out.push(`.${cls} { page: ${name}; }\n`);
    const style = cfg?.style ?? "arabic";
    const show = cfg?.show ?? true;
    if (show && style !== "none") {
      out.push(
        `@page ${name} {\n  @bottom-center {\n    content: counter(page, ${NUM_STYLE[style]});\n  }\n}\n`,
      );
    }
  }
  out.push(`.zone-body { counter-reset: page 1; }\n`);

  // 3. Running headers (§4.8) — odd pages are recto (:right)
  out.push(`.chapter .title { string-set: chapter-title content(text); }\n`);
  out.push(`.part .title { string-set: part-title content(text); }\n`);
  const emitEntries = (side: ":right" | ":left", entries: RunningEntry[] | undefined) => {
    for (const entry of entries ?? []) {
      const decls = [`    content: ${runningContent(entry.content, opts.bookTitle)};`];
      for (const [k, v] of Object.entries(entry)) {
        if (k === "content" || k === "area") continue;
        decls.push(`    ${k}: ${v};`);
      }
      out.push(`@page ${side} {\n  @${entry.area} {\n${decls.join("\n")}\n  }\n}\n`);
    }
  };
  emitEntries(":right", metadata.running?.odd);
  emitEntries(":left", metadata.running?.even);

  // 4. TOC + cross-reference page numbers (§4.11 items 9–10)
  out.push(`.toc a.entry::after { content: target-counter(attr(href url), page); }\n`);
  out.push(`a.ref::after { content: target-counter(attr(href url), page); }\n`);

  // 5. Footnote placement (§4.10)
  if (metadata.notes?.placement === "footnote") {
    out.push(`.note { float: footnote; }\n`);
  }

  return out.join("");
}

export function generateFontLinks(metadata: Metadata): string {
  const families = Object.values(metadata.fonts ?? {});
  if (!families.length) return "";
  const params = families
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:ital,wght@0,400;0,700;1,400;1,700`)
    .join("&");
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${params}&display=swap">`,
  ].join("\n");
}
