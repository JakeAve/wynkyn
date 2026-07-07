// metadata/css-generator.ts — Metadata → CSS strings (spec §5.2). Pure, no I/O.
import type { CssProps, Metadata } from "./types.ts";

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
  if (fonts && value in fonts) return `"${fonts[value]}"`;
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
