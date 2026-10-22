// server/import/text.ts — plain text and Markdown into blocks (spec §7.9).
// Handles Project Gutenberg downloads: the header's Title/Author lines, the
// START/END markers, hard-wrapped paragraphs, `_emphasis_`, `[Illustration:
// caption]`, two-line headings ("CHAPTER I." then the title) and indented
// verse. A contents list (a run of heading-like lines) becomes a `toc` block.
import { esc, norm, type Source, squash, verseLines } from "./blocks.ts";

const START = /\*\*\* ?START OF/i;
const END = /\*\*\* ?END OF/i;
export const KEYWORD =
  /^(chapter|part|book|stave|letter|canto|act|scene|section|prologue|epilogue|preface|introduction|foreword|afterword|appendix|etymology|extracts|dedication|contents|conclusion|interlude)\b/i;
const NUMERAL = /^([IVXLCDM]+|\d+)\.?$/;
const BREAK = /^(\*\s*){2,}$|^-{3,}$|^_{3,}$|^~{3,}$|^(•\s*){3,}$/;
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

const isCaps = (t: string) =>
  t.length > 3 && t.length <= 60 && t === t.toUpperCase() &&
  /[A-Z]{3}/.test(t) && !/[!?,;]$/.test(t);
const isKeyword = (t: string) =>
  t.length < 80 && (KEYWORD.test(t) || NUMERAL.test(t));
const headingLike = (t: string) => isKeyword(t) || isCaps(t);

/** `_word_` → `{em}word{/em}`; Markdown `*word*` too. */
function inline(t: string, md: boolean): string {
  let s = esc(t);
  s = s.replace(
    /(^|[\s(“"'])_([^_\n]{1,200}?)_(?=[\s.,;:!?)”"']|$)/g,
    "$1{em}$2{/em}",
  );
  if (md) {
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(
      /(^|\s)\*([^*\n]+)\*/g,
      "$1{em}$2{/em}",
    );
  }
  return s;
}

export function readText(name: string, raw: string): Source {
  const md = /\.(md|markdown)$/i.test(name);
  let lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const src: Source = { name, tocTitles: [], blocks: [], images: {} };

  const st = lines.findIndex((l) => START.test(l));
  if (st >= 0) {
    for (const l of lines.slice(0, st)) {
      const m = l.match(
        /^(Title|Author|Language|Release date|Original publication):\s*(.+)$/i,
      );
      if (!m) continue;
      const k = m[1]!.toLowerCase(), v = m[2]!.trim();
      if (k === "title") src.title = v;
      else if (k === "author") src.author = v;
      else if (k === "release date") src.gutenberg = v.match(/#(\d+)/)?.[1];
      else if (k === "original publication") {
        src.year = v.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];
      }
    }
    const en = lines.findIndex((l, i) => i > st && END.test(l));
    lines = lines.slice(st + 1, en < 0 ? undefined : en);
  }

  // Paragraphs: runs of non-blank lines.
  const paras: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim()) cur.push(l);
    else if (cur.length) {
      paras.push(cur);
      cur = [];
    }
  }
  if (cur.length) paras.push(cur);

  // Indented paragraphs are verse, unless the whole file is indented (some
  // transcriptions), when only a ragged right edge gives verse away.
  const indented = paras.filter((p) => p.every((l) => /^\s/.test(l))).length;
  const indentIsVerse = indented < paras.length * 0.5;
  const ragged = (p: string[]) => {
    const max = Math.max(...p.map((l) => l.trimEnd().length));
    return p.length >= 2 &&
      p.filter((l) => l.trimEnd().length < max * 0.75).length >= p.length * 0.4;
  };
  // ALL-CAPS lines are headings only when nothing better marks the chapters:
  // with CHAPTER lines present they are signatures, telegrams, shouting.
  const keywordCount =
    paras.filter((p) => p.length === 1 && isKeyword(p[0]!.trim())).length;
  const capsAreHeadings = keywordCount < 2;
  // Every heading-like standalone line, so a contents list written in Title
  // Case ("The Sisters" for THE SISTERS) can be recognised by what it lists.
  const headingNorms = new Set<string>();
  for (const p of paras) {
    const t = p.map((l) => l.trim());
    if (t.length === 1 && headingLike(t[0]!)) headingNorms.add(norm(t[0]!));
    if (t.length === 2 && isKeyword(t[0]!)) headingNorms.add(norm(t[1]!));
  }
  const PAGED = /\s{2,}([ivxlcdm]+|\d+)\s*$/i; // "Dedication      vii"

  for (const p of paras) {
    const trimmed = p.map((l) => l.trim());
    const one = trimmed.length === 1 ? trimmed[0]! : null;
    if (md) {
      const h = one?.match(MD_HEADING);
      if (h) {
        src.blocks.push({
          kind: "heading",
          level: h[1]!.length,
          text: inline(h[2]!, md),
        });
        continue;
      }
      if (trimmed.every((l) => l.startsWith(">"))) {
        src.blocks.push({
          kind: "quote",
          text: inline(
            squash(trimmed.map((l) => l.replace(/^>\s?/, "")).join(" ")),
            md,
          ),
        });
        continue;
      }
    }
    // A contents list written in Title Case: short lines, most of which name
    // a heading found elsewhere.
    if (
      trimmed.length >= 3 && trimmed.every((l) =>
        l.length <= 60 && !/[.!?,;:]$/.test(l)
      ) &&
      trimmed.filter((l) => headingNorms.has(norm(l))).length >=
        trimmed.length * 0.6
    ) {
      src.blocks.push({ kind: "toc" });
      src.tocTitles.push(...trimmed);
      continue;
    }
    if (one && BREAK.test(one)) {
      src.blocks.push({ kind: "break" });
      continue;
    }
    const ill = trimmed.join(" ").match(/^\[Illustration:?\s*([^\]]*)\]$/i);
    if (ill) {
      src.blocks.push({
        kind: "image",
        src: "",
        alt: inline(squash(ill[1]!.replace(/_/g, "")), md),
      });
      continue;
    }
    // A lone contents entry with its page number ("Dedication     vii").
    if (one && PAGED.test(one) && headingLike(one.replace(PAGED, ""))) {
      src.blocks.push({ kind: "toc" });
      src.tocTitles.push(one.replace(PAGED, ""));
      continue;
    }
    if (one && (isKeyword(one) || (capsAreHeadings && isCaps(one)))) {
      src.blocks.push({
        kind: "heading",
        level: 2,
        text: inline(one.replace(/[_\[\]]/g, ""), md),
      });
      continue;
    }
    // "CHAPTER I." with its title on the next line.
    if (
      trimmed.length === 2 && isKeyword(trimmed[0]!) && trimmed[1]!.length < 80
    ) {
      src.blocks.push({
        kind: "heading",
        level: 2,
        text: inline(trimmed[0]!, md),
        sub: inline(trimmed[1]!.replace(/_/g, ""), md),
      });
      continue;
    }
    // A run of heading-like lines with nothing between: the source's contents.
    if (
      trimmed.length >= 3 && trimmed.every((l) =>
        headingLike(l.replace(/\s{2,}.*$/, "")) || /^\s*\d+\s*$/.test(l)
      )
    ) {
      src.blocks.push({ kind: "toc" });
      src.tocTitles.push(...trimmed.map((l) => l.replace(PAGED, "").trim()));
      continue;
    }
    if (
      trimmed.length >= 2 && p.every((l) => /^\s/.test(l)) &&
      (indentIsVerse || ragged(p))
    ) {
      src.blocks.push({
        kind: "verse",
        lines: verseLines(p).map((l) => inline(l, md)),
      });
      continue;
    }
    src.blocks.push({
      kind: "para",
      text: inline(squash(trimmed.join(" ")), md),
    });
  }
  return src;
}
