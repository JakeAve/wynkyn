// web/src/prose-model.ts — how the Prose view (design-language.md §8.1) shows
// each line of a manuscript: folded or shown, its rubric in the left margin,
// its kind (title, subtitle, block indent), a stand-in (⁂, an illustration)
// and the `%%` notes behind a ☞ in the right margin. Pure; prose.ts draws it.
import { parseSentinelLine, type SentinelTag } from "../../parser/sentinel.ts";
import { RULE_RE, STRUCTURAL } from "./bml-language.ts";

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
  kind?: "title" | "subtitle" | "block";
  standIn?: "break" | "illustration";
  note?: string; // folded `%%` lines beside this one, joined by "\n"
  slug?: string; // the stand-in's slug: the image, the kind of break
}

const NEXT_KIND: Record<string, "title" | "subtitle"> = {
  title: "title",
  heading: "title",
  subheading: "title",
  subtitle: "subtitle",
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

// Plates and drop-cap images stay as plain markup (decided 2026-10-26).
const plain = (t: SentinelTag) =>
  (t.name === "illustration" && t.params.placement === "full-page") ||
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

// `cursor` is a 0-based line; its paragraph reveals its markup.
export function proseLines(lines: string[], cursor: number): ProseLine[] {
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
  const revealed = (i: number) => i >= p0 && i <= p1;

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
    if (plain(t)) return;
    at(i).fold = !revealed(i);
    if (t.closing) return;
    if (t.name === "break" || t.name === "illustration") {
      at(i).standIn = t.name;
      if (t.slug) at(i).slug = t.slug;
    }
    // The rubric sits on the text it opens; a structural line, a break, a
    // column mark, or a sentinel with no text of its own (or whose text an
    // outer sentinel already labels) carries its own.
    const own = STRUCTURAL.has(t.name) || t.name === "break" ||
      t.name === "col";
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
