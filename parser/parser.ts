// parser/parser.ts — parse(source): BmlDocument (spec §5.1). Line-based, never throws.
import { parseSentinelLine, type SentinelTag } from "./sentinel.ts";
import { parseInlines } from "./inline.ts";
import type {
  BmlDocument, Break, Chapter, Component, ComponentName, ContentNode,
  DropcapParagraph, Epigraph, Heading, Illustration, Inline, IsBlock,
  MatterBlock, Note, Paragraph, Part, Poem, Pullquote, Quote, Sidebar,
} from "./types.ts";

const STRUCTURAL = new Set(["matter", "part", "chapter"]);

const COMPONENT_NAMES = new Set<string>([
  "title", "subtitle", "author", "editor", "translator", "publisher",
  "publisher-location", "year", "edition", "series", "series-number",
  "copyright-line", "rights", "isbn", "printer", "typeface", "paper",
  "binding", "attribution",
]);

const PARAGRAPH_CLOSE = new Set<string>([
  ...COMPONENT_NAMES, "dropcap", "heading", "subheading", "illustration", "note",
]);

const PLACEMENTS = new Set(["inline", "half-page", "full-page", "full-spread", "margin"]);

const BLOCK_NAMES = new Set(["epigraph", "quote", "poem", "pullquote", "sidebar", "is"]);

interface OpenBlock {
  name: string;
  node: ContentNode;
  explicit: boolean;
  className?: string; // {is:} only
}

export function parse(source: string): BmlDocument {
  const lines = source.split(/\r?\n/);
  const doc: BmlDocument = { frontMatter: [], body: [], backMatter: [], diagnostics: [] };

  let zone: "front" | "body" | "back" = "front";
  let curMatter: MatterBlock | null = null;
  let curPart: Part | null = null;
  let curChapter: Chapter | null = null;

  let paraLines: string[] = [];
  let paraStart = 0;
  let pending: { tag: SentinelTag; line: number } | null = null;
  const blockStack: OpenBlock[] = [];

  const diag = (line: number, message: string) => doc.diagnostics.push({ line, message });

  const structuralChildren = (line: number): ContentNode[] => {
    if (curChapter) return curChapter.children;
    if (curPart) return curPart.children as ContentNode[];
    if (curMatter) return curMatter.children;
    diag(line, "content before any {matter:}, {part:}, or {chapter:} — placed in an implicit chapter");
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
    const node: Paragraph = {
      kind: "paragraph",
      inlines: parseInlines(paraLines),
      line: paraStart,
    };
    container(paraStart).push(node);
    paraLines = [];
  };

  const finalizePending = (tag: SentinelTag, line: number, inlines: Inline[]) => {
    const topBlock = blockStack[blockStack.length - 1];
    if (topBlock && topBlock.node.kind === "poem") {
      diag(line, `{${tag.name}} is not allowed inside {poem}`);
      return;
    }
    const c = container(line);
    if (COMPONENT_NAMES.has(tag.name)) {
      const comp: Component = { kind: "component", name: tag.name as ComponentName, inlines, line };
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
        diag(line, "{attribution} has no preceding epigraph, quote, poem, or pullquote to bind to");
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
        const il: Illustration = { kind: "illustration", slug: tag.slug ?? "", line };
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

  const popImplicitBlocks = () => {
    while (blockStack.length && !blockStack[blockStack.length - 1]!.explicit) {
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
      default: // is
        if (!tag.slug) diag(line, "{is:} requires a class name");
        node = { kind: "is", className: tag.slug ?? "", children: [], line };
    }
    container(line).push(node);
    const ob: OpenBlock = { name: tag.name, node, explicit };
    if (tag.slug && tag.name === "is") ob.className = tag.slug;
    blockStack.push(ob);
  };

  const closeBlock = (tag: SentinelTag, line: number) => {
    const matches = (b: OpenBlock) =>
      b.name === tag.name && (tag.name !== "is" || b.className === tag.slug);
    const top = blockStack[blockStack.length - 1];
    if (top && matches(top)) {
      blockStack.pop();
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
    diag(line, `{/${tag.name}} closes a block that is not the innermost open block (§3.2.3 rule 1)`);
    blockStack.length = idx; // recovery: force-close it and everything inside it
  };

  const openStructural = (tag: SentinelTag, line: number) => {
    blockStack.length = 0;
    if (zone === "back" && tag.name !== "matter") {
      diag(line, `{${tag.name}:} after back matter began — body cannot resume (§3.3)`);
    }
    if (tag.name === "matter") {
      const m: MatterBlock = { kind: "matter", type: tag.slug ?? "", children: [], line };
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
    if (!tag.closing && tag.name === "break") {
      const topBlock = blockStack[blockStack.length - 1];
      if (topBlock && topBlock.node.kind === "poem") {
        diag(line, "{break} is not allowed inside {poem}");
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
      popImplicitBlocks();
      continue;
    }
    const tag = parseSentinelLine(trimmed);
    if (tag) {
      flushParagraph();
      popImplicitBlocks();
      handleTag(tag, line);
      continue;
    }
    if (!paraLines.length) paraStart = line;
    paraLines.push(trimmed);
  }
  flushParagraph();
  popImplicitBlocks();
  return doc;
}
