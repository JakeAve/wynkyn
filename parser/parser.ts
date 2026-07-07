// parser/parser.ts — parse(source): BmlDocument (spec §5.1). Line-based, never throws.
import { parseSentinelLine, type SentinelTag } from "./sentinel.ts";
import { parseInlines } from "./inline.ts";
import type {
  BmlDocument,
  Chapter,
  ContentNode,
  MatterBlock,
  Paragraph,
  Part,
} from "./types.ts";

const STRUCTURAL = new Set(["matter", "part", "chapter"]);

export function parse(source: string): BmlDocument {
  const lines = source.split(/\r?\n/);
  const doc: BmlDocument = { frontMatter: [], body: [], backMatter: [], diagnostics: [] };

  let zone: "front" | "body" | "back" = "front";
  let curMatter: MatterBlock | null = null;
  let curPart: Part | null = null;
  let curChapter: Chapter | null = null;

  let paraLines: string[] = [];
  let paraStart = 0;

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

  // Task 5 replaces this with a block-stack-aware version.
  const container = (line: number): ContentNode[] => structuralChildren(line);

  const flushParagraph = () => {
    if (!paraLines.length) return;
    const node: Paragraph = {
      kind: "paragraph",
      inlines: parseInlines(paraLines),
      line: paraStart,
    };
    container(paraStart).push(node);
    paraLines = [];
  };

  const openStructural = (tag: SentinelTag, line: number) => {
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

  // Tasks 4–6 extend this dispatch.
  const handleTag = (tag: SentinelTag, line: number) => {
    if (!tag.closing && STRUCTURAL.has(tag.name)) {
      openStructural(tag, line);
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
      continue;
    }
    const tag = parseSentinelLine(trimmed);
    if (tag) {
      flushParagraph();
      handleTag(tag, line);
      continue;
    }
    if (!paraLines.length) paraStart = line;
    paraLines.push(trimmed);
  }
  flushParagraph();
  return doc;
}
