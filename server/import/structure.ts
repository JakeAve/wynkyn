// server/import/structure.ts — the block stream into a book outline (spec
// §7.9): drop the source's own furniture (Gutenberg header and licence, its
// contents list, "THE END"), pick the heading level that means "chapter",
// group chapters under parts, split front and back matter, and record the
// other readings that were plausible so the editor can offer them.
import { type Block, norm, type Source } from "./blocks.ts";

export interface ImportOptions {
  /** Heading level whose headings start chapters; "none" for one chapter. */
  chapters?: "auto" | number | "none";
  /** Group chapters under BOOK/PART headings when the file has them. */
  parts?: boolean;
  /** Keep verse line breaks (false reflows verse into paragraphs). */
  verse?: boolean;
}

/** One alternative way of reading the file, for "Read it differently". */
export interface Reading {
  label: string;
  options: ImportOptions;
  current: boolean;
}

export interface Section {
  type: string; // matter type: preface, introduction, appendix…
  title?: string;
  content: Block[];
  check?: string;
}
export interface ChapterNode {
  kind: "chapter";
  slug: string;
  title?: string;
  subtitle?: string;
  content: Block[];
  check?: string;
}
export interface PartNode {
  kind: "part";
  slug: string;
  title?: string;
  content: Block[]; // before its first chapter: an epigraph, a part-title verse
  chapters: ChapterNode[];
  check?: string;
}
export interface Outline {
  src: Source;
  front: Section[];
  body: (PartNode | ChapterNode)[];
  back: Section[];
  summary: string[]; // the `%%` block at the top of the manuscript
  readings: Reading[];
}

const PART_KW = /^(book|part|volume)\b/i;
const CHAPTER_KW =
  /^(chapter|stave|letter|canto|act|scene|section|prologue|epilogue|interlude|conclusion|etymology|extracts)\b/i;
const FRONT_KW =
  /^(preface|introduction|foreword|dedication|epigraph|prologue)\b/i;
const BACK_KW =
  /^(appendix|afterword|notes|endnotes|glossary|bibliography|index|colophon|acknowledg)/i;
const JUNK_HEADING =
  /^(the project gutenberg ebook|project gutenberg|contents|table of contents|illustrations|list of illustrations|the end|finis)\b/i;
const LABEL =
  /^(chapter|stave|book|part|volume|letter|canto|act|scene|section)\s+(?:the\s+)?([ivxlcdm]+|\d+|[a-z]+(?:-[a-z]+)?)\b\.?\s*[:.—–-]?\s*(.*)$/i;
const SMALL = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "nor",
]);

const plain = (t: string) => t.replace(/\{\/?em\}/g, "").replace(/\\\{/g, "{");

function roman(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!/^[ivxlcdm]+$/i.test(s)) return null;
  const v: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  let n = 0;
  const u = s.toLowerCase();
  for (let i = 0; i < u.length; i++) {
    const a = v[u[i]!]!, b = v[u[i + 1]!] ?? 0;
    n += a < b ? -a : a;
  }
  return n;
}

export function titleCase(t: string): string {
  if (t !== t.toUpperCase() || !/[A-Z]/.test(t)) return t;
  return t.toLowerCase().replace(
    /(^|[\s—–(\-])([a-zà-ÿ])([a-zà-ÿ'’]*)/g,
    (_m, pre, c, rest, off) => {
      const w = c + rest;
      return pre + (off > 0 && SMALL.has(w) ? w : c.toUpperCase() + rest);
    },
  );
}

export function slugify(t: string, words = 3): string {
  const s = plain(t).toLowerCase().replace(/['’]/g, "").replace(
    /[^a-z0-9]+/g,
    " ",
  ).trim().split(" ").filter(Boolean).slice(0, words).join("-");
  return s || "section";
}

/** "CHAPTER IV. The Carpet-Bag." → label "Chapter 4", title "The Carpet-Bag". */
export function parseHeading(
  text: string,
  sub?: string,
): { label?: string; title?: string } {
  const t = plain(text).trim().replace(/\.$/, "");
  const m = t.match(LABEL);
  if (m) {
    const n = roman(m[2]!);
    const label = `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${
      n ?? m[2]
    }`;
    const rest = (m[3] ?? "").trim().replace(/^[—–:.\-]\s*/, "").replace(
      /\.$/,
      "",
    );
    const title = rest || (sub ? plain(sub).replace(/\.$/, "") : "");
    return { label, title: title ? titleCase(title) : undefined };
  }
  const title = titleCase(t) +
    (sub ? `: ${titleCase(plain(sub).replace(/\.$/, ""))}` : "");
  return { title };
}

export function structure(src: Source, opts: ImportOptions = {}): Outline {
  const summary: string[] = [];
  const dropped = new Set<string>();
  let blocks = src.blocks.slice();
  const titleN = norm(src.title ?? ""), authorN = norm(src.author ?? "");

  // ---- the file's own furniture ------------------------------------------
  const startAt = blocks.findIndex((b) =>
    b.kind === "para" && /\*\*\* ?START OF/i.test(b.text)
  );
  if (startAt >= 0) blocks = blocks.slice(startAt + 1);
  const endAt = blocks.findIndex((b) =>
    (b.kind === "para" || b.kind === "heading") &&
    /\*\*\* ?END OF|full project gutenberg/i.test(b.text)
  );
  if (endAt >= 0) blocks = blocks.slice(0, endAt);
  if (startAt >= 0 || endAt >= 0 || src.gutenberg) {
    dropped.add("the Project Gutenberg header and licence");
  }

  const isJunk = (b: Block) => {
    if (b.kind === "toc") return true;
    if (b.kind !== "heading" && b.kind !== "para") return false;
    const t = plain(b.text).trim();
    if (!t) return true;
    const n = norm(t);
    const short = t.length <= 80;
    if (short && (n === titleN || n === authorN)) return true;
    if (short && n.length >= 6 && titleN.includes(n)) return true;
    if (
      short && /^by[a-z]/.test(n) && authorN.length > 3 && n.endsWith(authorN)
    ) return true;
    if (/^the end\.?$|^finis\.?$/i.test(t)) {
      dropped.add(`"${t}"`);
      return true;
    }
    return b.kind === "heading" && JUNK_HEADING.test(t) && t.length < 60;
  };
  if (blocks.some((b) => b.kind === "toc")) dropped.add("its contents list");
  blocks = blocks.filter((b) => !isJunk(b));

  // A run of heading-like lines whose texts recur later as headings is the
  // source's contents list, however it was marked up.
  const keep: Block[] = [];
  for (let i = 0; i < blocks.length;) {
    let j = i;
    while (
      j < blocks.length &&
      (blocks[j]!.kind === "heading" || blocks[j]!.kind === "para") &&
      plain((blocks[j] as { text: string }).text).length < 100
    ) j++;
    const run = blocks.slice(i, j);
    if (run.length >= 3) {
      const texts = run.map((b) => norm((b as { text: string }).text));
      const later = new Set(
        blocks.slice(j).filter((b) => b.kind === "heading").map((b) =>
          norm((b as { text: string }).text)
        ),
      );
      const hits = texts.filter((t) =>
        later.has(t) || [...later].some((l) =>
          t.length > 6 && (l.startsWith(t) || t.startsWith(l))
        )
      ).length;
      if (hits >= run.length * 0.6) {
        dropped.add("its contents list");
        for (const b of run) {
          src.tocTitles.push(plain((b as { text: string }).text));
        }
        i = j;
        continue;
      }
    }
    keep.push(...run.length ? run : [blocks[i]!]);
    i = Math.max(j, i + 1);
  }
  blocks = keep;

  // ---- which headings are chapters ---------------------------------------
  const heads = blocks.filter((b): b is Extract<Block, { kind: "heading" }> =>
    b.kind === "heading"
  );
  const counts = new Map<number, number>();
  for (const h of heads) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  const levels = [...counts.entries()].filter(([, n]) => n >= 2).map(([l]) => l)
    .sort((a, b) => a - b);

  let chapLevel: number | null = null;
  let partLevel: number | null = null;
  if (opts.chapters === "none") chapLevel = null;
  else if (typeof opts.chapters === "number") chapLevel = opts.chapters;
  else if (levels.length) {
    chapLevel = levels[0]!;
    const deeper = levels[1];
    if (
      deeper !== undefined &&
      counts.get(deeper)! >= 2 * counts.get(chapLevel)! &&
      counts.get(chapLevel)! <= 12
    ) {
      partLevel = chapLevel;
      chapLevel = deeper;
    }
  }
  // Same-level BOOK/PART headings above the chapters (Gutenberg marks both h2).
  const atChap = chapLevel === null
    ? []
    : heads.filter((h) => h.level === chapLevel);
  const kwParts = atChap.filter((h) => PART_KW.test(plain(h.text)));
  const wantParts = opts.parts ?? true;
  const partsByKeyword = partLevel === null && kwParts.length >= 2 &&
    atChap.length - kwParts.length >= 2 * kwParts.length;
  const useParts = wantParts && (partLevel !== null || partsByKeyword);

  // The file's own contents, when it lists most chapter headings, says which
  // same-level headings are not chapters (Gutenberg nav lists captions too, so
  // "contains" rather than equality).
  const toc = src.tocTitles.map(norm).filter((t) => t.length > 3);
  const inToc = (t: string) => {
    const n = norm(t);
    return n.length > 3 && toc.some((e) => e === n || e.includes(n));
  };
  const tocHits = atChap.filter((h) => inToc(h.text)).length;
  const useToc = toc.length > 0 && tocHits >= 2 &&
    tocHits >= atChap.length * 0.6;

  const isPartHead = (h: Extract<Block, { kind: "heading" }>) =>
    useParts &&
    (partLevel !== null
      ? h.level === partLevel
      : h.level === chapLevel && PART_KW.test(plain(h.text)));
  const isChapterHead = (h: Extract<Block, { kind: "heading" }>) =>
    chapLevel !== null && h.level === chapLevel && !isPartHead(h) &&
    (!useToc || inToc(h.text) || PART_KW.test(plain(h.text)) ||
      CHAPTER_KW.test(plain(h.text)));

  // ---- walk ---------------------------------------------------------------
  const front: Section[] = [];
  const body: (PartNode | ChapterNode)[] = [];
  const back: Section[] = [];
  const slugs = new Set<string>();
  const unique = (s: string) => {
    let out = s, n = 2;
    while (slugs.has(out)) out = `${s}-${n++}`;
    slugs.add(out);
    return out;
  };
  let preamble: Block[] = [];
  let part: PartNode | null = null;
  let chapter: ChapterNode | null = null;
  let backSection: Section | null = null;
  let demoted = 0;
  let coverImages = 0;

  const chapterFrom = (h: Extract<Block, { kind: "heading" }>): ChapterNode => {
    const { label, title } = parseHeading(h.text, h.sub);
    return {
      kind: "chapter",
      slug: unique(slugify(title ?? label ?? h.text)),
      title,
      content: [],
    };
  };
  const startBack = (text: string): Section => ({
    type: (BACK_KW.exec(text)?.[0] ?? "appendix").toLowerCase()
      .replace(/^acknowledg$/, "acknowledgements").replace(
        /^endnotes$/,
        "notes",
      ),
    title: titleCase(text.replace(/\.$/, "")),
    content: [],
  });
  const target = (): Block[] =>
    backSection
      ? backSection.content
      : chapter
      ? chapter.content
      : part
      ? part.content
      : preamble;

  for (const b of blocks) {
    if (b.kind === "heading") {
      const text = plain(b.text);
      if (
        body.length && b.level <= (chapLevel ?? 2) &&
        (backSection || BACK_KW.test(text))
      ) {
        backSection = startBack(text);
        back.push(backSection);
        continue;
      }
      if (backSection) {
        backSection.content.push({ kind: "heading", level: 1, text: b.text });
        continue;
      }
      if (!body.length && FRONT_KW.test(text) && !PART_KW.test(text)) {
        preamble.push(b);
        continue;
      }
      if (isPartHead(b)) {
        const { label, title } = parseHeading(b.text, b.sub);
        part = {
          kind: "part",
          slug: unique(slugify(title ?? label ?? b.text)),
          title,
          content: [],
          chapters: [],
        };
        body.push(part);
        chapter = null;
        continue;
      }
      if (isChapterHead(b)) {
        chapter = chapterFrom(b);
        if (part) part.chapters.push(chapter);
        else body.push(chapter);
        continue;
      }
      // Any other heading: a section heading inside the current chapter, or
      // front matter before the first chapter.
      if (!chapter && !body.length) {
        preamble.push(b);
        continue;
      }
      demoted++;
      const lvl = chapLevel === null ? 1 : b.level <= chapLevel + 1 ? 1 : 2;
      target().push({ kind: "heading", level: lvl, text: b.text, sub: b.sub });
      continue;
    }
    target().push(b);
  }

  // Images before the first chapter are a cover or frontispiece; with no
  // chapters at all they are the text's own, and stay.
  if (body.length) {
    coverImages = preamble.filter((b) => b.kind === "image").length;
    preamble = preamble.filter((b) => b.kind !== "image");
  }

  // A part with text but no chapter headings under it keeps its text (a
  // single long poem, say); say so once.
  const bare = body.find((n) =>
    n.kind === "part" && !n.chapters.length && n.content.length
  );
  if (bare) {
    bare.check =
      "no chapter heading under this part, so its text follows the part title. Add {chapter: slug} lines if it should be split.";
  }

  // No chapter headings at all: the whole text is one chapter.
  if (!body.length) {
    const ch: ChapterNode = {
      kind: "chapter",
      slug: unique(slugify(src.title ?? "text")),
      title: undefined,
      content: preamble,
      check:
        "no chapter headings were found, so the whole text is one chapter. Add {chapter: slug} lines where chapters begin.",
    };
    preamble = [];
    body.push(ch);
  }

  // ---- front matter from the preamble -------------------------------------
  let section: Section | null = null;
  const loose: Block[] = [];
  for (const b of preamble) {
    if (b.kind === "heading") {
      const text = plain(b.text);
      const m = FRONT_KW.exec(text);
      if (m) {
        section = {
          type: m[0]!.toLowerCase().replace("prologue", "introduction"),
          title: titleCase(text.replace(/\.$/, "")),
          content: [],
        };
        front.push(section);
        continue;
      }
      if (section) {
        section.content.push({ kind: "heading", level: 1, text: b.text });
      } else loose.push({ kind: "heading", level: 1, text: b.text });
      continue;
    }
    (section ? section.content : loose).push(b);
  }
  const looseText = loose.filter((b) => b.kind !== "break");
  if (looseText.length) {
    front.unshift({
      type: "preface",
      content: loose,
      check:
        `${looseText.length} paragraph(s) came before the first chapter heading. A preface, a dedication, an epigraph? Mark it, or delete it.`,
    });
  }

  // ---- verse ----------------------------------------------------------------
  const verseCount = blocks.filter((b) => b.kind === "verse").length;
  const keepVerse = opts.verse ?? true;
  if (!keepVerse) {
    const reflow = (bs: Block[]) =>
      bs.forEach((b, i) => {
        if (b.kind === "verse") {
          bs[i] = { kind: "para", text: b.lines.join(" "), check: b.check };
        }
      });
    for (const s of [...front, ...back]) reflow(s.content);
    for (const n of body) {
      if (n.kind === "part") {
        reflow(n.content);
        n.chapters.forEach((c) => reflow(c.content));
      } else reflow(n.content);
    }
  }

  // ---- checks on the first of a kind -----------------------------------------
  const firstChapter =
    body.find((n) => n.kind === "chapter") as ChapterNode | undefined ??
      (body[0] as PartNode | undefined)?.chapters[0];
  const firstHead = heads.find((h) => isChapterHead(h));
  if (firstChapter && firstHead) {
    const { label } = parseHeading(firstHead.text, firstHead.sub);
    if (label && !/^chapter/i.test(label)) {
      firstChapter.check = `the file calls these "${
        label.split(" ")[0]
      }s". Chapter labels come from the numbering settings, so rename them there if you want that word.`;
    }
  }

  // ---- summary and readings ---------------------------------------------------
  const chapters = body.reduce(
    (n, b) => n + (b.kind === "part" ? b.chapters.length : 1),
    0,
  );
  const how = chapLevel === null
    ? "no split"
    : src.name.match(/\.(epub|html?|xhtml|docx)$/i)
    ? `level-${chapLevel} headings`
    : atChap.some((h) =>
        CHAPTER_KW.test(plain(h.text)) || LABEL.test(plain(h.text))
      )
    ? "CHAPTER-style lines"
    : "standalone ALL-CAPS lines";
  const partCount = body.filter((b) => b.kind === "part").length;
  summary.push(
    partCount
      ? `${partCount} parts and ${chapters} chapters from ${how}${
        useToc ? ", checked against the file’s contents" : ""
      }.`
      : `${chapters} chapter${chapters === 1 ? "" : "s"} from ${how}${
        useToc ? ", checked against the file’s contents" : ""
      }.`,
  );
  if (demoted) {
    summary.push(
      `${demoted} other heading${
        demoted === 1 ? "" : "s"
      } became {heading} inside chapters.`,
    );
  }
  const emCount = JSON.stringify(blocks).split("{em}").length - 1;
  const imageCount = blocks.filter((b) => b.kind === "image").length;
  const bits = [
    emCount
      ? `${emCount} emphasised run${emCount === 1 ? "" : "s"} became {em}`
      : "no emphasis found",
    imageCount
      ? `${imageCount} illustration${imageCount === 1 ? "" : "s"}`
      : null,
    verseCount
      ? (keepVerse
        ? `${verseCount} verse block${
          verseCount === 1 ? "" : "s"
        } kept as {poem} with line breaks`
        : `${verseCount} verse block${
          verseCount === 1 ? "" : "s"
        } reflowed into prose`)
      : null,
  ].filter(Boolean);
  summary.push(bits.join("; ") + ".");
  if (coverImages) {
    dropped.add(
      `${coverImages} image${
        coverImages === 1 ? "" : "s"
      } before the first chapter (a cover, a frontispiece)`,
    );
  }
  if (dropped.size) summary.push(`Dropped: ${[...dropped].join("; ")}.`);

  const readings: Reading[] = [];
  if (levels.length > 1 || (partLevel !== null)) {
    for (const l of levels) {
      readings.push({
        label: `Chapters from level-${l} headings (${counts.get(l)})`,
        options: { chapters: l },
        current: l === chapLevel && opts.chapters !== "none",
      });
    }
  }
  if (partsByKeyword || partLevel !== null) {
    readings.push({
      label: `Group chapters under ${
        partLevel !== null ? "the shallower headings" : "BOOK/PART headings"
      } (${partLevel !== null ? counts.get(partLevel) : kwParts.length})`,
      options: { parts: true },
      current: useParts,
    });
    readings.push({
      label: "No parts",
      options: { parts: false },
      current: !useParts,
    });
  }
  if (verseCount) {
    readings.push({
      label: "Verse: keep line breaks",
      options: { verse: true },
      current: keepVerse,
    });
    readings.push({
      label: "Prose: reflow into paragraphs",
      options: { verse: false },
      current: !keepVerse,
    });
  }
  if (chapLevel !== null) {
    readings.push({
      label: "Don’t split into chapters",
      options: { chapters: "none" },
      current: false,
    });
  }
  if (readings.length) {
    summary.push("Another reading was possible: the import notes offer it.");
  }

  return { src, front, body, back, summary, readings };
}
