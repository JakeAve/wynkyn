// metadata/themes.ts — the preset themes (spec §4.13): partial metadata laid
// over a book, owning only its look. Pure; bundles into the browser app, so
// the data comes in as JSON imports, not a fetch.
import themesJson from "../templates/themes.json" with { type: "json" };
import template from "../templates/metadata.json" with { type: "json" };
import type { ElementStyle, Metadata, Numbering, Running } from "./types.ts";

export interface Theme {
  slug: string;
  name: string;
  description: string;
  fonts?: Record<string, string>;
  elements?: Record<string, unknown>;
  numbering?: Numbering;
  running?: Running;
}

export const THEMES: readonly Theme[] = themesJson as unknown as Theme[];

const HOUSE = template as unknown as Metadata;

type Look = Required<
  Pick<Metadata, "fonts" | "elements" | "numbering" | "running">
>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Deep merge where `null` in `b` deletes the key; arrays and scalars replace.
function merge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (!isObj(a) || !isObj(b)) return b;
  const o: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete o[k];
    else o[k] = merge(o[k], v);
  }
  return o;
}

/** House deep-merged with the theme's overrides. Throws on an unknown slug. */
export function themeLook(slug: string): Look {
  const t = THEMES.find((t) => t.slug === slug);
  if (!t) throw new Error(`no such theme: ${slug}`);
  return structuredClone({
    fonts: merge(HOUSE.fonts ?? {}, t.fonts) as Record<string, string>,
    elements: merge(HOUSE.elements ?? {}, t.elements) as Record<
      string,
      ElementStyle
    >,
    numbering: merge(HOUSE.numbering ?? {}, t.numbering) as Numbering,
    running: merge(HOUSE.running ?? {}, t.running) as Running,
  });
}

// A copy without any `show`: whether numbers appear is the book's choice.
function withoutShow(v: unknown): unknown {
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => k !== "show").map((
      [k, x],
    ) => [k, withoutShow(x)]),
  );
}

// Drops objects left empty by clearing, so a reset leaves no `{}` behind.
function prune(o: Obj): Obj {
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v) && Object.keys(prune(v)).length === 0) delete o[k];
  }
  return o;
}

/**
 * The book with the theme's look in place of its own (spec §4.13): font
 * aliases merged over the book's, each named element replaced wholesale, the
 * owned numbering keys reset then set, `running` replaced. Everything else,
 * and every `show`, is left alone. Does not mutate `meta`.
 */
export function applyTheme(meta: Metadata, slug: string): Metadata {
  const look = themeLook(slug);
  const out = structuredClone(meta);
  const n = (out.numbering ?? {}) as Numbering;
  for (const s of [n.chapters, n.parts]) {
    delete s?.style;
    delete s?.prefix;
    delete s?.suffix;
  }
  if (n.pages) {
    const p = n.pages;
    delete p.css;
    delete p.position;
    delete p.gap;
    delete p.openers?.position; // openers.show is the book's
    for (const z of [p["front-matter"], p.body, p["back-matter"]]) {
      if (z) delete z.style;
    }
  }
  out.fonts = { ...out.fonts, ...look.fonts };
  out.elements = { ...out.elements, ...look.elements };
  out.numbering = prune(
    merge(n, withoutShow(look.numbering)) as Obj,
  ) as Numbering;
  out.running = look.running;
  return out;
}
