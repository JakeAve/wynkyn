// web/src/prose-model.ts — how the Prose view (design-language.md §8.1) shows
// each line of a manuscript: folded or shown, its rubric in the left margin,
// its kind (title, subtitle, block indent), a stand-in (⁂, an illustration)
// and the `%%` notes behind a ☞ in the right margin. Pure; prose.ts draws it.
import { parseSentinelLine, type SentinelTag } from "../../parser/sentinel.ts";
import {
  RULE_RE,
  STRUCTURAL,
  structuralBlock,
  wrapRanges,
} from "./bml-language.ts";

export interface Rubric {
  label: string;
  slug?: string;
  rule?: boolean; // matter, part, chapter: a hairline across the text column
}

// `fold` hides the line's own text. A folded line that carries a rubric or a
// stand-in keeps its row (the rubric and rule, ⁂, the image); a folded line
// with neither collapses into the line above. Rubrics, kinds and stand-ins
// don't depend on the cursor; only `fold` and `note` do.
export interface ProseLine {
  fold: boolean;
  rubric?: Rubric;
  kind?: "title" | "subtitle" | "block" | "caption";
  standIn?: "break" | "illustration";
  note?: string; // folded `%%` lines beside this one, joined by "\n"
  slug?: string; // the stand-in's slug: the image, the kind of break
}

const NEXT_KIND: Record<string, "title" | "subtitle" | "caption"> = {
  title: "title",
  heading: "title",
  subheading: "title",
  subtitle: "subtitle",
  illustration: "caption",
};
const INDENT = new Set(["quote", "epigraph", "poem", "pullquote"]);
// Explicit-close sentinels: their first text line may sit past a nested tag.
const WRAPS = new Set([
  ...INDENT,
  "sidebar",
  "verses",
  "columns",
  "is",
  "only",
]);

// Plates, drop-cap images and illustrations whose file is missing stay as
// plain markup (decided 2026-10-26). `hasImage` unknown: none is missing.
const plain = (t: SentinelTag, hasImage?: (slug: string) => boolean) =>
  (t.name === "illustration" &&
    (t.params.placement === "full-page" ||
      (!!hasImage && !hasImage(t.slug ?? "")))) ||
  (t.name === "dropcap" && "image" in t.params);

function rubricOf(t: SentinelTag): Rubric {
  if (t.name === "is") return { label: t.slug ?? "Is" };
  const label = t.name === "dropcap"
    ? "Drop cap"
    : t.name[0]!.toUpperCase() + t.name.slice(1).replaceAll("-", " ");
  const slug = t.name === "only"
    ? [...(t.slug?.split(/\s+/) ?? []), ...Object.keys(t.params)].join(" · ")
    : t.slug;
  const r: Rubric = { label };
  if (slug) r.slug = slug;
  if (STRUCTURAL.has(t.name)) r.rule = true;
  return r;
}

// `cursor` is a 0-based line; its paragraph reveals its markup. `hasImage`
// says whether an illustration's file exists, once the book's images are known.
// `line`, if given, reveals that one line alone (the cursor's, in prose.ts).
export function proseLines(
  lines: string[],
  cursor: number,
  hasImage?: (slug: string) => boolean,
  line = -1,
): ProseLine[] {
  const tags = lines.map((l) => parseSentinelLine(l));
  const blank = (i: number) => lines[i]!.trim() === "";
  const comment = (i: number) => lines[i]!.startsWith("%%");
  const isText = (i: number) => !tags[i] && !blank(i) && !comment(i);
  const out: ProseLine[] = lines.map(() => ({ fold: false }));
  const at = (i: number) => out[i]!;

  // The cursor's paragraph; none on a blank line.
  let p0 = cursor, p1 = cursor - 1;
  if (lines[cursor]?.trim()) {
    while (p0 > 0 && !blank(p0 - 1)) p0--;
    p1 = cursor;
    while (p1 < lines.length - 1 && !blank(p1 + 1)) p1++;
  }
  const revealed = (i: number) => i >= p0 && i <= p1 || i === line;

  // The first text line `t` (on line i) opens, or -1: within its paragraph,
  // past `%%` lines, and past nested tags only for an explicit-close block.
  const firstText = (i: number, t: SentinelTag) => {
    for (let j = i + 1; j < lines.length && !blank(j); j++) {
      const u = tags[j];
      if (!u) {
        if (!comment(j)) return j;
      } else if (!WRAPS.has(t.name) || u.closing) return -1;
    }
    return -1;
  };
  // The line a block ends on: its closing tag, else (spec §3.2.3) the end of
  // its first paragraph, which the next blank line or sentinel ends.
  const blockEnd = (i: number, t: SentinelTag) => {
    for (let j = i + 1; j < lines.length; j++) {
      const u = tags[j];
      if (u?.closing && u.name === t.name && (!u.slug || u.slug === t.slug)) {
        return j;
      }
      if (u && !u.closing && STRUCTURAL.has(u.name)) break;
    }
    let j = i + 1;
    while (j < lines.length && !blank(j) && !tags[j]) j++;
    return j;
  };

  tags.forEach((t, i) => {
    if (!t) {
      if (comment(i)) at(i).fold = !revealed(i);
      return;
    }
    if (plain(t, hasImage)) return;
    at(i).fold = !revealed(i);
    if (t.closing) return;
    if (t.name === "break" || t.name === "illustration") {
      at(i).standIn = t.name;
      if (t.slug) at(i).slug = t.slug;
    }
    // The rubric sits on the text it opens; a structural line, a break, an
    // illustration (beside its image), a column mark, or a sentinel with no
    // text of its own (or whose text an outer sentinel already labels)
    // carries its own.
    const own = STRUCTURAL.has(t.name) || t.name === "break" ||
      t.name === "illustration" || t.name === "col";
    const j = own ? -1 : firstText(i, t);
    at(j === -1 || at(j).rubric ? i : j).rubric = rubricOf(t);

    const next = NEXT_KIND[t.name];
    if (next) {
      for (let k = i + 1; k < lines.length && !blank(k) && !tags[k]; k++) {
        if (isText(k)) at(k).kind = next;
      }
    }
    if (INDENT.has(t.name)) {
      const end = blockEnd(i, t);
      for (let k = i + 1; k < end; k++) {
        if (isText(k)) at(k).kind ??= "block";
      }
    }
  });

  // Folded `%%` lines become notes: on the nearest shown line above in the
  // same paragraph, else the next shown line, else any shown line above.
  // Rule lines (box-drawing only) are decoration and are dropped.
  const shown = (i: number) =>
    !blank(i) && (!at(i).fold || !!at(i).rubric || !!at(i).standIn);
  lines.forEach((line, i) => {
    if (!comment(i) || !at(i).fold || RULE_RE.test(line)) return;
    let h = -1;
    for (let j = i - 1; j >= 0 && !blank(j) && h === -1; j--) {
      if (shown(j)) h = j;
    }
    for (let j = i + 1; j < lines.length && h === -1; j++) if (shown(j)) h = j;
    for (let j = i - 1; j >= 0 && h === -1; j--) if (shown(j)) h = j;
    if (h === -1) return;
    const text = line.slice(2).trim();
    at(h).note = at(h).note === undefined ? text : `${at(h).note}\n${text}`;
  });
  return out;
}

// The text of a prose line without its inline tags: `{em}`/`{/em}` and
// `{footnote: x}` / `{ref: x}` are cut (so `wo{em}rd{/em}` is one word), and
// an escaped character stands for itself. A footnote inside an em is cut too.
function plainText(line: string): string {
  const cuts = wrapRanges(line).flatMap((
    { name, at: [a, s, e, b] },
  ): [number, number][] => name === "em" ? [[a, s], [e, b]] : [[a, b]])
    .sort((x, y) => x[0] - y[0]);
  let out = "", at = 0;
  for (const [a, b] of cuts) {
    if (a > at) out += line.slice(at, a);
    at = Math.max(at, b);
  }
  return (out + line.slice(at)).replace(/\\(.)/g, "$1");
}

// Words in the manuscript's prose: no sentinel lines, no `%%` lines, no tags.
// A word has a letter or digit in it, so a lone dash isn't one.
export function wordCount(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (line.startsWith("%%") || parseSentinelLine(line)) continue;
    for (const w of plainText(line).split(/\s+/)) {
      if (/[\p{L}\p{N}]/u.test(w)) n++;
    }
  }
  return n;
}

// The chapter holding `line` (1-based): its slug and the first line under its
// `{title}`, if it has one. null before any chapter, or in a matter or part.
export function chapterAt(
  lines: string[],
  line: number,
): { slug: string; title: string | null } | null {
  const [from, to] = structuralBlock(
    (n) => lines[n - 1] ?? "",
    lines.length,
    line,
  );
  const head = parseSentinelLine(lines[from - 1] ?? "");
  if (head?.name !== "chapter" || head.closing) return null;
  let title: string | null = null;
  for (let n = from + 1; n <= to && title === null; n++) {
    const t = parseSentinelLine(lines[n - 1]!);
    if (t?.name !== "title" || t.closing) continue;
    // the first text line under it, in its paragraph
    for (let m = n + 1; m <= to && lines[m - 1]!.trim() !== ""; m++) {
      const l = lines[m - 1]!;
      if (!l.startsWith("%%") && !parseSentinelLine(l)) {
        title = plainText(l).trim() || null;
        break;
      }
    }
    break;
  }
  return { slug: head.slug ?? "", title };
}
