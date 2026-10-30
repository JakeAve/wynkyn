// server/history-diff.ts — pure diffs shared by the History view and snapshot
// summaries: manuscript paragraphs (by chapter, word-level) and metadata leaves.
import { parse } from "../parser/parser.ts";
import type { Metadata } from "../metadata/types.ts";

export type Seg = { t: string; op: "same" | "ins" | "del" };
export type ChapterDiff = { chapter: string; paras: { segs: Seg[] }[] };
export type StyleChange = { path: string[]; from: unknown; to: unknown };

interface Para {
  text: string;
  line: number; // 1-based first source line
}

/** Blank-line separated source paragraphs; the separators are not kept. */
function paragraphs(source: string): Para[] {
  const out: Para[] = [];
  let buf: string[] = [];
  let start = 0;
  source.split(/\r?\n/).forEach((l, i) => {
    if (l.trim()) {
      if (!buf.length) start = i + 1;
      buf.push(l);
    } else if (buf.length) {
      out.push({ text: buf.join("\n"), line: start });
      buf = [];
    }
  });
  if (buf.length) out.push({ text: buf.join("\n"), line: start });
  return out;
}

/** Name for a source line: the nearest matter/part/chapter starting at or above it. */
function chapterNamer(source: string): (line: number) => string {
  const doc = parse(source);
  const marks: { line: number; name: string }[] = [];
  for (const m of [...doc.frontMatter, ...doc.backMatter]) {
    marks.push({ line: m.line, name: m.label ?? m.type });
  }
  for (const b of doc.body) {
    marks.push({ line: b.line, name: b.slug });
    if (b.kind === "part") {
      for (const c of b.children) {
        if (c.kind === "chapter") marks.push({ line: c.line, name: c.slug });
      }
    }
  }
  // stray text before any sentinel lands in an implicit chapter with no tag line
  const lines = source.split(/\r?\n/);
  marks.sort((a, b) => a.line - b.line);
  const real = marks.filter((m) =>
    lines[m.line - 1]?.trimStart().startsWith("{")
  );
  return (line) => {
    let name = "Front matter";
    for (const m of real) {
      if (m.line > line) break;
      name = m.name;
    }
    return name;
  };
}

const LCS_MAX_CELLS = 4_000_000; // ~16 MB of Uint32 table

/** LCS alignment of two sequences: matched index pairs, in order. */
function lcs<T>(a: T[], b: T[]): [number, number][] {
  const n = a.length, m = b.length, w = m + 1;
  // ponytail: O(n·m) table; fine after prefix/suffix trimming, and diffText
  // skips it past LCS_MAX_CELLS. Myers if mid-size rewrites get slow.
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j]
        ? t[(i + 1) * w + j + 1]! + 1
        : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

function pushSeg(segs: Seg[], t: string, op: Seg["op"]) {
  const last = segs.at(-1);
  if (last && last.op === op) last.t += t;
  else segs.push({ t, op });
}

/** Word-level diff of one paragraph; whitespace tokens are kept. */
function diffWords(a: string, b: string): Seg[] {
  const ta = a.match(/\s+|\S+/g) ?? [], tb = b.match(/\s+|\S+/g) ?? [];
  const segs: Seg[] = [];
  let i = 0, j = 0;
  for (const [mi, mj] of [...lcs(ta, tb), [ta.length, tb.length]]) {
    while (i < mi!) pushSeg(segs, ta[i++]!, "del");
    while (j < mj!) pushSeg(segs, tb[j++]!, "ins");
    if (i < ta.length && j < tb.length) pushSeg(segs, ta[i++]!, "same"), j++;
  }
  return segs;
}

export function diffText(before: string, after: string): ChapterDiff[] {
  const a = paragraphs(before), b = paragraphs(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre]!.text === b[pre]!.text) {
    pre++;
  }
  let suf = 0;
  while (
    suf < a.length - pre && suf < b.length - pre &&
    a[a.length - 1 - suf]!.text === b[b.length - 1 - suf]!.text
  ) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return [];

  const nameBefore = chapterNamer(before), nameAfter = chapterNamer(after);
  const out: ChapterDiff[] = [];
  const add = (chapter: string, segs: Seg[]) => {
    const last = out.at(-1);
    if (last && last.chapter === chapter) last.paras.push({ segs });
    else out.push({ chapter, paras: [{ segs }] });
  };

  // A rewrite too big to align: the whole middle out, then the whole middle in.
  if (am.length * bm.length > LCS_MAX_CELLS) {
    for (const p of am) add(nameBefore(p.line), [{ t: p.text, op: "del" }]);
    for (const p of bm) add(nameAfter(p.line), [{ t: p.text, op: "ins" }]);
    return out;
  }
  let i = 0, j = 0;
  const matches = lcs(am.map((p) => p.text), bm.map((p) => p.text));
  for (const [mi, mj] of [...matches, [am.length, bm.length]]) {
    // ponytail: pairs removed/added paragraphs in a gap by position; a similarity match if pairing misfires.
    while (i < mi! && j < mj!) {
      add(nameAfter(bm[j]!.line), diffWords(am[i++]!.text, bm[j++]!.text));
    }
    while (i < mi!) {
      const p = am[i++]!;
      add(nameBefore(p.line), [{ t: p.text, op: "del" }]);
    }
    while (j < mj!) {
      const p = bm[j++]!;
      add(nameAfter(p.line), [{ t: p.text, op: "ins" }]);
    }
    i++, j++;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Leaf-level changes between two metadata files; arrays compare as one value. */
export function diffMetadata(
  before: Metadata | null,
  after: Metadata | null,
): StyleChange[] {
  const out: StyleChange[] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[k], b[k], [...path, k]);
      }
    } else if (isObj(a) || isObj(b)) {
      // an object added, removed, or replaced by a scalar: report its leaves
      walk(isObj(a) ? a : {}, isObj(b) ? b : {}, path);
      if (!isObj(a) && a !== undefined) {
        out.push({ path, from: a, to: undefined });
      }
      if (!isObj(b) && b !== undefined) {
        out.push({ path, from: undefined, to: b });
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path, from: a, to: b });
    }
  };
  walk(before ?? {}, after ?? {}, []);
  return out;
}
