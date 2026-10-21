// parser/parser.ts — parse(source): BmlDocument (spec §5.1). Line-based, never throws.
import { parseSentinelLine, type SentinelTag } from "./sentinel.ts";
import { parseInlines } from "./inline.ts";
import { DISPLAY_MATTER } from "./types.ts";
import type {
  BmlDocument,
  Break,
  Chapter,
  Component,
  ComponentName,
  ContentNode,
  Diagnostic,
  DropcapParagraph,
  Heading,
  Illustration,
  Inline,
  List,
  MatterBlock,
  OnlySpan,
  Part,
} from "./types.ts";

const STRUCTURAL = new Set(["matter", "part", "chapter"]);

const COMPONENT_NAMES = new Set<string>([
  "title",
  "subtitle",
  "author",
  "editor",
  "translator",
  "publisher",
  "publisher-location",
  "year",
  "edition",
  "series",
  "series-number",
  "copyright-line",
  "rights",
  "isbn",
  "printer",
  "typeface",
  "paper",
  "binding",
  "attribution",
]);

const PARAGRAPH_CLOSE = new Set<string>([
  ...COMPONENT_NAMES,
  "dropcap",
  "heading",
  "subheading",
  "illustration",
  "note",
]);

const PLACEMENTS = new Set([
  "inline",
  "half-page",
  "full-page",
  "full-spread",
  "margin",
]);

const BLOCK_NAMES = new Set([
  "epigraph",
  "quote",
  "poem",
  "pullquote",
  "sidebar",
  "is",
  "verses",
  "columns",
]);

const UL_RE = /^-\s+(.*)$/;
const OL_RE = /^(\d+)\.\s+(.*)$/;

interface OpenBlock {
  name: string;
  node: ContentNode;
  explicit: boolean;
  className?: string; // {is:} only
}

// EXPERIMENTAL: an {only} edition token that is not in `known` gets one
// diagnostic on that span's opening line.
export function checkOnlySpans(
  spans: OnlySpan[],
  known: string[],
): Diagnostic[] {
  return spans.flatMap((s) =>
    s.editions.filter((e) => !known.includes(e)).map((e) => ({
      line: s.line,
      message: `{only} names unknown edition "${e}"`,
    }))
  );
}

// `opts.edition` keeps only the {only} spans that list it; without it (editor,
// `bml check`) every span's content is parsed.
export function parse(
  source: string,
  opts: { edition?: string } = {},
): BmlDocument {
  const lines = source.split(/\r?\n/);
  const doc: BmlDocument = {
    frontMatter: [],
    body: [],
    backMatter: [],
    diagnostics: [],
    onlySpans: [],
  };

  let zone: "front" | "body" | "back" = "front";
  let curMatter: MatterBlock | null = null;
  let curPart: Part | null = null;
  let curChapter: Chapter | null = null;

  let paraLines: string[] = [];
  let paraStart = 0;
  let pending: { tag: SentinelTag; line: number } | null = null;
  const blockStack: OpenBlock[] = [];

  const diag = (line: number, message: string) =>
    doc.diagnostics.push({ line, message });

  // EXPERIMENTAL {only} pre-pass: tag lines and dropped content become blank
  // lines, so line numbers and the block-close lookahead see the gated text.
  const onlyOpeners = new Set<number>();
  const onlyStack: { span: OnlySpan; keep: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const tag = parseSentinelLine(lines[i]!);
    if (tag?.name === "only") {
      lines[i] = "";
      if (tag.closing) {
        const open = onlyStack.pop();
        if (open) open.span.endLine = line;
        else diag(line, "stray closing tag {/only}");
        continue;
      }
      const editions = [
        ...(tag.slug ? [tag.slug] : []),
        ...Object.keys(tag.params).filter((k) => tag.params[k] === ""),
      ];
      const span: OnlySpan = { line, endLine: lines.length, editions };
      doc.onlySpans.push(span);
      if (!editions.length) diag(line, "{only} names no edition");
      if (onlyStack.length) diag(line, "{only} opened inside another {only}");
      else onlyOpeners.add(line);
      onlyStack.push({
        span,
        keep: (onlyStack.at(-1)?.keep ?? true) &&
          (opts.edition === undefined || editions.includes(opts.edition)),
      });
      continue;
    }
    if (onlyStack.length && !onlyStack.at(-1)!.keep) lines[i] = "";
  }
  for (const { span } of onlyStack) {
    diag(span.line, "{only} is never closed by {/only}");
  }

  const structuralChildren = (line: number): ContentNode[] => {
    if (curChapter) return curChapter.children;
    if (curPart) return curPart.children as ContentNode[];
    if (curMatter) return curMatter.children;
    diag(
      line,
      "content before any {matter:}, {part:}, or {chapter:} — placed in an implicit chapter",
    );
    curChapter = { kind: "chapter", slug: "untitled", children: [], line };
    zone = "body";
    doc.body.push(curChapter);
    return curChapter.children;
  };

  const container = (line: number): ContentNode[] => {
    const top = blockStack[blockStack.length - 1];
    if (!top) return structuralChildren(line);
    const n = top.node;
    switch (n.kind) {
      case "epigraph":
      case "quote":
      case "pullquote":
      case "sidebar":
      case "is":
        return n.children;
      case "poem":
        return n.stanzas as ContentNode[];
      case "verses":
        return n.verses as ContentNode[];
      case "columns":
        return n.columns[n.columns.length - 1]!;
      default:
        return structuralChildren(line);
    }
  };

  const flushParagraph = () => {
    if (pending) {
      const inlines = paraLines.length ? parseInlines(paraLines) : [];
      const p = pending;
      pending = null;
      paraLines = [];
      finalizePending(p.tag, p.line, inlines);
      return;
    }
    if (!paraLines.length) return;
    const node: ContentNode = tryList(paraLines, paraStart) ?? {
      kind: "paragraph",
      inlines: parseInlines(paraLines),
      line: paraStart,
    };
    container(paraStart).push(node);
    paraLines = [];
  };

  const tryList = (rawLines: string[], line: number): List | null => {
    if (rawLines.every((l) => UL_RE.test(l))) {
      return {
        kind: "list",
        ordered: false,
        items: rawLines.map((l) => parseInlines([l.match(UL_RE)![1]!])),
        line,
      };
    }
    if (rawLines.every((l) => OL_RE.test(l))) {
      return {
        kind: "list",
        ordered: true,
        start: parseInt(rawLines[0]!.match(OL_RE)![1]!, 10),
        items: rawLines.map((l) => parseInlines([l.match(OL_RE)![2]!])),
        line,
      };
    }
    return null;
  };

  const finalizePending = (
    tag: SentinelTag,
    line: number,
    inlines: Inline[],
  ) => {
    const topBlock = blockStack[blockStack.length - 1];
    if (
      topBlock &&
      (topBlock.node.kind === "poem" || topBlock.node.kind === "verses") &&
      // a dropcap opens a verse the way it opens any other paragraph (§3.5.7)
      !(topBlock.node.kind === "verses" && tag.name === "dropcap")
    ) {
      diag(line, `{${tag.name}} is not allowed inside {${topBlock.node.kind}}`);
      return;
    }
    const c = container(line);
    if (COMPONENT_NAMES.has(tag.name)) {
      const comp: Component = {
        kind: "component",
        name: tag.name as ComponentName,
        inlines,
        line,
      };
      if (tag.name === "attribution") {
        const prev = c[c.length - 1];
        if (
          prev &&
          (prev.kind === "epigraph" || prev.kind === "quote" ||
            prev.kind === "poem" || prev.kind === "pullquote")
        ) {
          prev.attribution = comp;
          return;
        }
        diag(
          line,
          "{attribution} has no preceding epigraph, quote, poem, or pullquote to bind to",
        );
      }
      c.push(comp);
      return;
    }
    switch (tag.name) {
      case "dropcap": {
        if (!inlines.length) diag(line, "{dropcap} has no following paragraph");
        const d: DropcapParagraph = { kind: "dropcap", inlines, line };
        if (tag.params["image"]) d.image = tag.params["image"];
        c.push(d);
        return;
      }
      case "heading":
      case "subheading": {
        const h: Heading = {
          kind: "heading",
          level: tag.name === "heading" ? 1 : 2,
          inlines,
          line,
        };
        if (tag.slug) h.slug = tag.slug;
        c.push(h);
        return;
      }
      case "illustration": {
        const il: Illustration = {
          kind: "illustration",
          slug: tag.slug ?? "",
          line,
        };
        if (!tag.slug) diag(line, "{illustration:} requires a slug");
        const placement = tag.params["placement"];
        if (placement) {
          if (PLACEMENTS.has(placement)) {
            il.placement = placement as Illustration["placement"];
          } else {
            diag(line, `invalid illustration placement "${placement}"`);
          }
        }
        if (inlines.length) il.caption = inlines;
        c.push(il);
        return;
      }
      case "note": {
        if (!tag.slug) diag(line, "{note:} requires a slug");
        c.push({ kind: "note", slug: tag.slug ?? "", inlines, line });
        return;
      }
    }
  };

  const popImplicitBlocks = (line: number) => {
    while (blockStack.length && !blockStack[blockStack.length - 1]!.explicit) {
      checkColumnsDividers(blockStack[blockStack.length - 1]!, line);
      blockStack.pop();
    }
  };

  // Lookahead from the line AFTER `line` (1-based `line` == index of next line).
  const hasExplicitClose = (tag: SentinelTag, line: number): boolean => {
    for (let j = line; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (t.startsWith("\\") || t.startsWith("%%")) continue;
      const other = parseSentinelLine(t);
      if (!other) continue;
      if (!other.closing && STRUCTURAL.has(other.name)) return false;
      const sameTarget = other.name === tag.name &&
        (tag.name !== "is" || other.slug === tag.slug);
      if (sameTarget) return other.closing;
    }
    return false;
  };

  const openBlock = (tag: SentinelTag, line: number) => {
    const explicit = hasExplicitClose(tag, line);
    let node: ContentNode;
    switch (tag.name) {
      case "epigraph":
        node = { kind: "epigraph", children: [], line };
        break;
      case "quote":
        node = { kind: "quote", children: [], line };
        break;
      case "pullquote":
        node = { kind: "pullquote", children: [], line };
        break;
      case "poem":
        node = { kind: "poem", stanzas: [], line };
        break;
      case "sidebar":
        node = { kind: "sidebar", children: [], line };
        break;
      case "verses": {
        if (!tag.slug) diag(line, "{verses:} requires a slug");
        const start = parseInt(tag.params["start"] ?? "1", 10);
        node = {
          kind: "verses",
          slug: tag.slug ?? "",
          start: Number.isFinite(start) && start >= 1 ? start : 1,
          verses: [],
          line,
        };
        break;
      }
      case "columns": {
        const count = parseInt(tag.slug ?? "", 10);
        if (!Number.isFinite(count) || count < 1) {
          diag(line, `{columns:} requires a positive integer column count`);
        }
        node = {
          kind: "columns",
          count: Number.isFinite(count) && count >= 1 ? count : 1,
          mode: "flow",
          columns: [[]],
          line,
        };
        break;
      }
      default: // is
        if (!tag.slug) diag(line, "{is:} requires a class name");
        node = { kind: "is", className: tag.slug ?? "", children: [], line };
    }
    container(line).push(node);
    const ob: OpenBlock = { name: tag.name, node, explicit };
    if (tag.slug && tag.name === "is") ob.className = tag.slug;
    blockStack.push(ob);
  };

  const checkColumnsDividers = (b: OpenBlock, line: number) => {
    if (
      b.node.kind === "columns" && b.node.mode === "parallel" &&
      b.node.columns.length !== b.node.count
    ) {
      diag(
        line,
        `{columns: ${b.node.count}} has ${
          b.node.columns.length - 1
        } {col} dividers; expected ${b.node.count - 1} (§3.6.5)`,
      );
    }
  };

  const closeBlock = (tag: SentinelTag, line: number) => {
    const matches = (b: OpenBlock) =>
      b.name === tag.name && (tag.name !== "is" || b.className === tag.slug);
    const top = blockStack[blockStack.length - 1];
    if (top && matches(top)) {
      blockStack.pop();
      checkColumnsDividers(top, line);
      return;
    }
    let idx = -1;
    for (let j = blockStack.length - 1; j >= 0; j--) {
      if (matches(blockStack[j]!)) {
        idx = j;
        break;
      }
    }
    if (idx === -1) {
      diag(line, `stray closing tag {/${tag.name}}`);
      return;
    }
    diag(
      line,
      `{/${tag.name}} closes a block that is not the innermost open block (§3.2.3 rule 1)`,
    );
    for (let j = blockStack.length - 1; j >= idx; j--) {
      checkColumnsDividers(blockStack[j]!, line);
    }
    blockStack.length = idx; // recovery: force-close it and everything inside it
  };

  const openStructural = (tag: SentinelTag, line: number) => {
    for (const b of blockStack) checkColumnsDividers(b, line);
    blockStack.length = 0;
    if (zone === "back" && tag.name !== "matter") {
      diag(
        line,
        `{${tag.name}:} after back matter began — body cannot resume (§3.3)`,
      );
    }
    if (tag.name === "matter") {
      const m: MatterBlock = {
        kind: "matter",
        type: tag.slug ?? "",
        children: [],
        line,
      };
      if (tag.params["label"]) m.label = tag.params["label"];
      if (!tag.slug) diag(line, "{matter:} requires a type");
      curMatter = m;
      curPart = null;
      curChapter = null;
      if (zone === "body") zone = "back";
      (zone === "front" ? doc.frontMatter : doc.backMatter).push(m);
      return;
    }
    if (tag.name === "part") {
      if (zone === "front") zone = "body";
      curMatter = null;
      curChapter = null;
      curPart = { kind: "part", slug: tag.slug ?? "", children: [], line };
      if (!tag.slug) diag(line, "{part:} requires a slug");
      doc.body.push(curPart);
      return;
    }
    // chapter
    if (zone === "front") zone = "body";
    curMatter = null;
    curChapter = { kind: "chapter", slug: tag.slug ?? "", children: [], line };
    if (!tag.slug) diag(line, "{chapter:} requires a slug");
    if (curPart) curPart.children.push(curChapter);
    else doc.body.push(curChapter);
  };

  // Task 6 extends this dispatch.
  const handleTag = (tag: SentinelTag, line: number) => {
    if (!tag.closing && STRUCTURAL.has(tag.name)) {
      openStructural(tag, line);
      return;
    }
    if (BLOCK_NAMES.has(tag.name)) {
      if (tag.closing) closeBlock(tag, line);
      else openBlock(tag, line);
      return;
    }
    if (!tag.closing && tag.name === "col") {
      const topBlock = blockStack[blockStack.length - 1];
      if (topBlock && topBlock.node.kind === "columns") {
        topBlock.node.mode = "parallel";
        topBlock.node.columns.push([]);
      } else {
        diag(line, "{col} outside a {columns:} block");
      }
      return;
    }
    if (!tag.closing && tag.name === "break") {
      const topBlock = blockStack[blockStack.length - 1];
      if (
        topBlock &&
        (topBlock.node.kind === "poem" || topBlock.node.kind === "verses")
      ) {
        diag(line, `{break} is not allowed inside {${topBlock.node.kind}}`);
        return;
      }
      const b: Break = { kind: "break", line };
      if (tag.slug) b.slug = tag.slug;
      container(line).push(b);
      return;
    }
    if (!tag.closing && PARAGRAPH_CLOSE.has(tag.name)) {
      pending = { tag, line };
      return;
    }
    diag(line, `unhandled sentinel {${tag.closing ? "/" : ""}${tag.name}}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const trimmed = lines[i]!.trim();

    if (trimmed.startsWith("\\")) {
      // §3.2.8: leading backslash strips the line's markup meaning — always prose.
      if (!paraLines.length) paraStart = line;
      paraLines.push(trimmed);
      continue;
    }
    if (trimmed.startsWith("%%")) continue; // comment: invisible, paragraph continues
    if (trimmed === "") {
      flushParagraph();
      popImplicitBlocks(line);
      const open = blockStack.at(-1);
      if (open && onlyOpeners.has(line)) {
        diag(
          line,
          `{only} opened inside an open {${open.name}} block — it gates whole blocks`,
        );
      }
      continue;
    }
    const tag = parseSentinelLine(trimmed);
    if (tag) {
      flushParagraph();
      popImplicitBlocks(line);
      handleTag(tag, line);
      continue;
    }
    if (!paraLines.length) paraStart = line;
    paraLines.push(trimmed);
  }
  flushParagraph();
  popImplicitBlocks(lines.length);

  // §3.4.6/§3.4.7/§3.7: the generated contents lists only matter blocks that
  // carry a {title}, so a block written without one silently disappears from
  // it. A colophon is exempt — it is back matter but carries no heading by
  // convention, and is not listed.
  const hasTitle = (m: MatterBlock) =>
    m.children.some((c) => c.kind === "component" && c.name === "title");
  for (const m of [...doc.frontMatter, ...doc.backMatter]) {
    if (!m.type || hasTitle(m)) continue; // a missing type is already diagnosed
    if (m.type === "toc") {
      diag(
        m.line,
        "{matter: toc} has no {title} — the contents page will render without a heading",
      );
    } else if (!DISPLAY_MATTER.has(m.type) && m.type !== "colophon") {
      diag(
        m.line,
        `{matter: ${m.type}} has no {title} — it will not appear in the table of contents`,
      );
    }
  }
  return doc;
}
