// renderer/render.ts — BmlDocument → semantic HTML (spec §5.3). Pure, no I/O.
import "./folios.js";
import { matterType } from "../parser/types.ts";
import { selectorFor } from "../metadata/css-generator.ts";
import type { Segment } from "./page-map-types.ts";
import type {
  BmlDocument,
  Chapter,
  Component,
  ContentNode,
  DropcapParagraph,
  Inline,
  MatterBlock,
  Note,
  Part,
} from "../parser/types.ts";
import type {
  ElementStyle,
  Metadata,
  NotesConfig,
  Numbering,
  NumberingStyle,
  StructureNumbering,
  TocConfig,
} from "../metadata/types.ts";

export interface RenderOptions {
  numbering?: Numbering;
  notes?: NotesConfig;
  toc?: TocConfig;
  images?: Record<string, string>; // slug → relative path; resolved by the caller
  language?: string; // BCP 47 (spec §4.2); stamped on the article as `lang`
  bookTitle?: string; // set above the first chapter's number (`openers`, §4.14)
  elements?: Metadata["elements"]; // read for breaks only, by renderSegments
  is?: Metadata["is"]; // ditto: an {is} block's forced break-after
  onePage?: Metadata["one-page"];
}

// folios.js is a classic script (toHtml inlines it), so its formatter hangs
// off this global; importing it here keeps one formatter for pages and
// chapters alike.
declare const BookPageMap: {
  formatNumber(n: number, style: NumberingStyle): string;
};

export function formatNumber(n: number, style: NumberingStyle): string {
  return BookPageMap.formatNumber(n, style);
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  )
    .replaceAll('"', "&quot;");
}

// Every block carries its manuscript line so a click in the preview can find
// its source. Paged.js copies attributes onto both halves of a split element.
const dl = (n: { line: number }) => ` data-line="${n.line}"`;

// ── note machinery ──────────────────────────────────────────────────────────
interface NoteCtx {
  placement: "footnote" | "endnote";
  notes: Map<string, Note>;
  // slug → its number, in first-anchor order: a repeated anchor reuses it.
  numbers: Map<string, number>;
}

function collectNotes(nodes: ContentNode[], map: Map<string, Note>): void {
  for (const n of nodes) {
    // §3.2.4: a duplicated slug resolves to the first occurrence.
    if (n.kind === "note") {
      if (!map.has(n.slug)) map.set(n.slug, n);
    } else if ("children" in n && Array.isArray(n.children)) {
      collectNotes(n.children as ContentNode[], map);
    } else if (n.kind === "columns") {
      for (const col of n.columns) collectNotes(col, map);
    }
  }
}

// ── inline rendering ────────────────────────────────────────────────────────
function renderInlines(inlines: Inline[], ctx: NoteCtx): string {
  let out = "";
  for (const i of inlines) {
    switch (i.kind) {
      case "text":
        out += escapeHtml(i.text);
        break;
      case "em":
        out += `<em>${renderInlines(i.children, ctx)}</em>`;
        break;
      case "linebreak":
        out += "<br>";
        break;
      case "ref":
        out += `<a class="ref" href="#${escapeHtml(i.slug)}"></a>`;
        break;
      case "footnote": {
        // An anchor with no note is left out; the parser diagnoses it.
        const note = ctx.notes.get(i.slug);
        if (!note) break;
        const slug = escapeHtml(i.slug);
        const seen = ctx.numbers.get(i.slug);
        if (seen !== undefined) { // a repeat: the number again, no second id
          out +=
            `<sup class="footnote-anchor"><a href="#note-${slug}">${seen}</a></sup>`;
          break;
        }
        // Numbered before the note's own inlines render, so a note that
        // footnotes itself (or a→b→a) meets itself as a repeat and stops.
        const n = ctx.numbers.size + 1;
        ctx.numbers.set(i.slug, n);
        if (ctx.placement === "footnote") {
          out += `<sup class="footnote-anchor" id="fnref-${slug}">${n}</sup>` +
            `<span class="note" id="note-${slug}">${
              renderInlines(note.inlines, ctx)
            }</span>`;
        } else {
          out +=
            `<sup class="footnote-anchor" id="fnref-${slug}"><a href="#note-${slug}">${n}</a></sup>`;
        }
        break;
      }
    }
  }
  return out;
}

function inlinePlainText(inlines: Inline[]): string {
  let out = "";
  for (const i of inlines) {
    if (i.kind === "text") out += i.text;
    else if (i.kind === "em") out += inlinePlainText(i.children);
    else if (i.kind === "linebreak") out += " ";
  }
  return out;
}

function dropcapHtml(
  node: DropcapParagraph,
  ctx: NoteCtx,
  opts: RenderOptions,
  extraClass = "",
  prefix = "",
): string {
  const src = node.image ? opts.images?.[node.image] : undefined;
  // §3.5.4: the initial stands for the paragraph's first letter, image or not.
  const { head, rest } = splitFirstChar(node.inlines);
  const initial = src
    ? `<img class="dropcap" src="${escapeHtml(src)}" alt="${
      escapeHtml(head)
    }">${renderInlines(rest, ctx)}`
    : `<span class="dropcap">${escapeHtml(head)}</span>${
      renderInlines(rest, ctx)
    }`;
  return `<p class="has-dropcap${extraClass}"${
    dl(node)
  }>${prefix}${initial}</p>`;
}

function splitFirstChar(inlines: Inline[]): { head: string; rest: Inline[] } {
  if (!inlines.length) return { head: "", rest: inlines };
  const first = inlines[0]!;
  const others = inlines.slice(1);
  if (first.kind === "text") {
    if (!first.text.length) {
      return splitFirstChar(others);
    }
    const head = first.text.charAt(0);
    const restText = first.text.slice(1);
    const rest: Inline[] = restText
      ? [{ kind: "text", text: restText }, ...others]
      : others;
    return { head, rest };
  }
  if (first.kind === "em") {
    const sub = splitFirstChar(first.children);
    const rest: Inline[] = sub.rest.length
      ? [{ kind: "em", children: sub.rest }, ...others]
      : others;
    return { head: sub.head, rest };
  }
  // linebreak/footnote/ref as the very first inline: no text to split off.
  return { head: "", rest: inlines };
}

function titleOf(children: (ContentNode | Chapter)[]): string | null {
  return componentText(children, "title");
}

function componentText(
  children: (ContentNode | Chapter)[],
  name: "title" | "subtitle",
): string | null {
  for (const c of children) {
    if (c.kind === "component" && c.name === name) {
      return inlinePlainText(c.inlines);
    }
  }
  return null;
}

// ── content rendering ───────────────────────────────────────────────────────
// A paragraph that opens a block carries no indent: the first in its container
// (a sidebar, a column, an untitled section) or directly after a title, a
// heading or a break. That used to be `h1 + p` / `.break + p` in base.css, but
// Paged.js drops `+` rules whole (.claude/skills/architecture/references/pagedjs-plus-combinator.md), so the
// class is decided here.
function opensBlock(prev: ContentNode | undefined): boolean {
  return !prev || prev.kind === "break" || prev.kind === "heading" ||
    (prev.kind === "component" && prev.name === "title");
}

function renderChildren(
  nodes: ContentNode[],
  ctx: NoteCtx,
  opts: RenderOptions,
): string {
  return nodes.map((n, i) =>
    renderContent(n, ctx, opts, opensBlock(nodes[i - 1]))
  ).join("");
}

function renderContent(
  node: ContentNode,
  ctx: NoteCtx,
  opts: RenderOptions,
  lead = false,
): string {
  switch (node.kind) {
    case "paragraph":
      return `<p${lead ? ' class="lead"' : ""}${dl(node)}>${
        renderInlines(node.inlines, ctx)
      }</p>`;
    case "component": {
      if (node.name === "title") {
        return `<h1 class="title"${dl(node)}>${
          renderInlines(node.inlines, ctx)
        }</h1>`;
      }
      return `<p class="${node.name}"${dl(node)}>${
        renderInlines(node.inlines, ctx)
      }</p>`;
    }
    case "dropcap":
      return dropcapHtml(node, ctx, opts);
    case "heading": {
      const tag = node.level === 1 ? "h3" : "h4";
      const cls = node.level === 1 ? "heading" : "subheading";
      const id = node.slug ? ` id="${escapeHtml(node.slug)}"` : "";
      return `<${tag} class="${cls}"${id}${dl(node)}>${
        renderInlines(node.inlines, ctx)
      }</${tag}>`;
    }
    case "break":
      return `<div class="break${
        node.slug ? ` break-${escapeHtml(node.slug)}` : ""
      }"${dl(node)}></div>`;
    case "epigraph":
    case "quote": {
      const inner = node.children.map((c) =>
        c.kind === "paragraph"
          ? `<p class="text"${dl(c)}>${renderInlines(c.inlines, ctx)}</p>`
          : renderContent(c, ctx, opts)
      ).join("");
      return `<blockquote class="${node.kind}"${dl(node)}>${inner}${
        attribution(node.attribution, ctx)
      }</blockquote>`;
    }
    case "pullquote": {
      const inner = renderChildren(node.children, ctx, opts);
      return `<aside class="pullquote"${dl(node)}>${inner}${
        attribution(node.attribution, ctx)
      }</aside>`;
    }
    case "poem": {
      const stanzas = node.stanzas.map((s) =>
        s.kind === "paragraph"
          ? `<p class="stanza"${dl(s)}>${renderInlines(s.inlines, ctx)}</p>`
          : ""
      ).join("");
      return `<div class="poem"${dl(node)}>${stanzas}${
        attribution(node.attribution, ctx)
      }</div>`;
    }
    case "sidebar":
      return `<aside class="sidebar"${dl(node)}>${
        renderChildren(node.children, ctx, opts)
      }</aside>`;
    case "verses": {
      // No space after the number: in justified text it is the first stretchable
      // space on the line, so it soaks up the whole line's justification slack
      // and reads as a ragged indent. base.css spaces it with padding instead.
      const verses = node.verses.map((v, i) => {
        const num = `<span class="number">${node.start + i}</span>`;
        return v.kind === "dropcap"
          ? dropcapHtml(v, ctx, opts, " verse", num)
          : `<p class="verse"${dl(v)}>${num}${
            renderInlines(v.inlines, ctx)
          }</p>`;
      }).join("");
      return `<div class="verses" id="${escapeHtml(node.slug)}"${
        dl(node)
      }>${verses}</div>`;
    }
    case "columns": {
      if (node.mode === "flow") {
        const inner = renderChildren(node.columns[0] ?? [], ctx, opts);
        return `<div class="columns columns-flow" style="column-count: ${node.count}"${
          dl(node)
        }>${inner}</div>`;
      }
      const cols = node.columns.map((col) =>
        `<div class="col">${renderChildren(col, ctx, opts)}</div>`
      ).join("");
      return `<div class="columns columns-parallel" style="grid-template-columns: repeat(${node.count}, 1fr)"${
        dl(node)
      }>${cols}</div>`;
    }
    case "is":
      return `<div class="is is-${escapeHtml(node.className)}"${dl(node)}>${
        renderChildren(node.children, ctx, opts)
      }</div>`;
    case "illustration": {
      const cls = `illustration${
        node.placement ? ` placement-${node.placement}` : ""
      }`;
      const captionText = node.caption ? inlinePlainText(node.caption) : "";
      const src = opts.images?.[node.slug];
      const media = src
        ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(captionText)}">`
        : `<div class="illustration-placeholder" data-slug="${
          escapeHtml(node.slug)
        }"><span>No image named ${
          escapeHtml(node.slug)
        } yet</span><span>Click to add one</span></div>`;
      const cap = node.caption
        ? `<figcaption class="caption">${
          renderInlines(node.caption, ctx)
        }</figcaption>`
        : "";
      return `<figure class="${cls}" id="${escapeHtml(node.slug)}"${
        dl(node)
      }>${media}${cap}</figure>`;
    }
    case "list": {
      // Items are one source line each, consecutive from the list's first line.
      const items = node.items.map((it, i) =>
        `<li data-line="${node.line + i}">${renderInlines(it, ctx)}</li>`
      ).join("");
      if (node.ordered) {
        const start = node.start && node.start !== 1
          ? ` start="${node.start}"`
          : "";
        return `<ol${start}>${items}</ol>`;
      }
      return `<ul>${items}</ul>`;
    }
    case "note":
      return ""; // rendered via the note machinery
  }
}

function attribution(attr: Component | undefined, ctx: NoteCtx): string {
  return attr
    ? `<p class="attribution"${dl(attr)}>${
      renderInlines(attr.inlines, ctx)
    }</p>`
    : "";
}

// ── structural rendering ────────────────────────────────────────────────────
function renderBlockWithNotes(
  children: ContentNode[],
  opts: RenderOptions,
  body: (ctx: NoteCtx) => string,
  zone?: Zone,
): string {
  const ctx: NoteCtx = {
    placement: opts.notes?.placement ?? "endnote",
    notes: new Map(),
    numbers: new Map(),
  };
  collectNotes(children, ctx.notes);
  let html = body(ctx);
  if (ctx.placement === "endnote" && ctx.notes.size) {
    // Unanchored notes follow the anchored ones (the parser diagnoses them).
    for (const s of ctx.notes.keys()) {
      if (!ctx.numbers.has(s)) ctx.numbers.set(s, ctx.numbers.size + 1);
    }
    // A Map visits entries added while iterating, so a note first anchored
    // inside another note is listed too.
    let rendered = "";
    for (const [s, n] of ctx.numbers) {
      const note = ctx.notes.get(s)!;
      rendered += `<div class="note" id="note-${escapeHtml(s)}"${
        dl(note)
      }><sup>${n}</sup> ${renderInlines(note.inlines, ctx)}</div>`;
    }
    html += `<aside class="notes${zoneClass(zone)}">${rendered}</aside>`;
  }
  return html;
}

function numberText(
  n: number,
  cfg: StructureNumbering | undefined,
): string {
  if (!cfg || cfg.show === false || !cfg.style || cfg.style === "none") {
    return "";
  }
  return `${cfg.prefix ?? ""}${formatNumber(n, cfg.style)}${cfg.suffix ?? ""}`;
}

function numberDiv(
  n: number,
  cfg: StructureNumbering | undefined,
): string {
  const t = numberText(n, cfg);
  return t ? `<div class="number">${escapeHtml(t)}</div>` : "";
}

// The zone class sits on each top-level block, never on a wrapper: an empty
// zone wrapper would be the first node on the zone's page, and Paged.js counts
// any element as content, so the first chapter's break-before would strand it
// on a blank page. A chapter inside a part gets no zone; the part carries it.
// A block's endnotes follow it as a top-level sibling and need the zone too:
// an element with no page name after one with `page: body` is a page-name
// change, which Paged.js breaks on, stranding the notes on a page of their own.
type Zone = "front" | "body" | "back";
const zoneClass = (zone?: Zone) => zone ? ` zone-${zone}` : "";

function renderChapter(
  ch: Chapter,
  n: number,
  opts: RenderOptions,
  zone?: Zone,
  start = false, // the first body block: base.css opens the body on a recto
): string {
  return renderBlockWithNotes(ch.children, opts, (ctx) => {
    const inner = renderChildren(ch.children, ctx, opts);
    return `<section class="chapter${zoneClass(zone)}${
      start ? " body-start" : ""
    }" id="${escapeHtml(ch.slug)}"${dl(ch)}>${
      n === 1 && opts.bookTitle
        ? `<p class="book-title">${escapeHtml(opts.bookTitle)}</p>`
        : ""
    }${numberDiv(n, opts.numbering?.chapters)}${inner}</section>`;
  }, zone);
}

// Raw (unescaped) ids — callers escape once at their own interpolation site
// (renderMatter into id="…", tocRow into href="#…") so they aren't
// double-escaped. "matter-<type>[-<label>]", the label slugified, and a
// repeat numbered (-2, -3) so each block's TOC row and folio find it.
export function matterIds(doc: BmlDocument): Map<MatterBlock, string> {
  const ids = new Map<MatterBlock, string>();
  const taken = new Set<string>();
  for (const m of [...doc.frontMatter, ...doc.backMatter]) {
    const label = (m.label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const base = `matter-${m.type}${label ? `-${label}` : ""}`;
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
    taken.add(id);
    ids.set(m, id);
  }
  return ids;
}

// A title page's publisher, place and year form one imprint block, set after
// the rest of the page (§3.4.2).
const IMPRINT = new Set(["publisher", "publisher-location", "year"]);

function renderMatter(
  m: MatterBlock,
  doc: BmlDocument,
  opts: RenderOptions,
  zone: Zone,
  rawId: string,
): string {
  const id = escapeHtml(rawId);
  const { display } = matterType(m.type);
  const onePage = opts.onePage?.[m.type] ?? display;
  const open = `<section class="matter matter-${escapeHtml(m.type)}${
    display ? " matter-display" : ""
  }${zoneClass(zone)}" id="${id}"${dl(m)}${onePage ? " data-one-page" : ""}>`;
  if (m.type === "toc") {
    const onlyTitles = m.children.every((c) =>
      c.kind === "component" && c.name === "title"
    );
    if (onlyTitles) {
      return renderBlockWithNotes(m.children, opts, (ctx) => {
        const title = renderChildren(m.children, ctx, opts);
        return `${open}${title}${generateToc(doc, opts)}</section>`;
      }, zone);
    }
  }
  return renderBlockWithNotes(m.children, opts, (ctx) => {
    if (m.type !== "title-page") {
      return `${open}${renderChildren(m.children, ctx, opts)}</section>`;
    }
    const inImprint = (c: ContentNode) =>
      c.kind === "component" && IMPRINT.has(c.name);
    const imprint = m.children.filter(inImprint);
    const rest = m.children.filter((c) => !inImprint(c));
    return `${open}${renderChildren(rest, ctx, opts)}${
      imprint.length
        ? `<div class="imprint">${renderChildren(imprint, ctx, opts)}</div>`
        : ""
    }</section>`;
  }, zone);
}

export interface TocRow {
  cls: string; // "toc-front" | "toc-part" | "toc-chapter" | "toc-heading" | "toc-back" (+ " in-part")
  href: string;
  label: string;
  number?: string;
  subtitle?: string | null;
}

function tocRow(r: TocRow): string {
  const href = escapeHtml(r.href);
  const number = r.number
    ? `<span class="number">${escapeHtml(r.number)}</span>`
    : "";
  const subtitle = r.subtitle
    ? `<span class="subtitle">${escapeHtml(r.subtitle)}</span>`
    : "";
  return `<div class="entry ${r.cls}">${number}<a class="label" href="#${href}">${
    escapeHtml(r.label)
  }</a>${subtitle}<span class="leader"></span><a class="page" href="#${href}"></a></div>`;
}

/** The contents rows in reading order — the printed TOC and the e-book's nav
 * document (server/epub-export.ts) are both set from them. */
export function tocRows(doc: BmlDocument, opts: RenderOptions): TocRow[] {
  const rows: TocRow[] = [];
  const ids = matterIds(doc);
  const matterRows = (blocks: MatterBlock[], cls: string) => {
    for (const m of blocks) {
      if (!matterType(m.type).listed) continue;
      const label = titleOf(m.children);
      if (label) rows.push({ cls, href: ids.get(m)!, label });
    }
  };
  matterRows(doc.frontMatter, "toc-front");

  let partNo = 0;
  let chapterNo = 0;
  const chapterRow = (ch: Chapter, inPart: boolean) => {
    const number = numberText(++chapterNo, opts.numbering?.chapters);
    rows.push({
      cls: `toc-chapter${inPart ? " in-part" : ""}`,
      href: ch.slug,
      label: titleOf(ch.children) ?? (number ? "" : ch.slug),
      number,
      subtitle: componentText(ch.children, "subtitle"),
    });
    if (opts.toc?.headings) {
      for (const c of ch.children) {
        if (c.kind === "heading" && c.level === 1 && c.slug) {
          rows.push({
            cls: `toc-heading${inPart ? " in-part" : ""}`,
            href: c.slug,
            label: inlinePlainText(c.inlines),
          });
        }
      }
    }
  };
  for (const b of doc.body) {
    if (b.kind === "part") {
      const number = numberText(++partNo, opts.numbering?.parts);
      rows.push({
        cls: "toc-part",
        href: b.slug,
        label: titleOf(b.children) ?? (number ? "" : b.slug),
        number,
        subtitle: componentText(b.children, "subtitle"),
      });
      for (const c of b.children) if (c.kind === "chapter") chapterRow(c, true);
    } else {
      chapterRow(b, false);
    }
  }
  matterRows(doc.backMatter, "toc-back");
  return rows;
}

function generateToc(doc: BmlDocument, opts: RenderOptions): string {
  return `<nav class="toc">${tocRows(doc, opts).map(tocRow).join("")}</nav>`;
}

// The part's own content, its section left open for its chapters.
function partOpener(
  part: Part,
  partNo: number,
  opts: RenderOptions,
  zone: Zone,
  start = false,
): string {
  const contentKids = part.children.filter((c) =>
    c.kind !== "chapter"
  ) as ContentNode[];
  const head = renderBlockWithNotes(
    contentKids,
    opts,
    (ctx) => renderChildren(contentKids, ctx, opts),
  );
  return `<section class="part${zoneClass(zone)}${
    start ? " body-start" : ""
  }" id="${escapeHtml(part.slug)}"${dl(part)}>${
    numberDiv(partNo, opts.numbering?.parts)
  }${head}`;
}

const partChapters = (part: Part) =>
  part.children.filter((c): c is Chapter => c.kind === "chapter");

function renderPart(
  part: Part,
  partNo: number,
  chapterNo: { n: number },
  opts: RenderOptions,
  zone: Zone,
  start = false,
): string {
  const chapters = partChapters(part)
    .map((ch) => renderChapter(ch, ++chapterNo.n, opts))
    .join("");
  return `${partOpener(part, partNo, opts, zone, start)}${chapters}</section>`;
}

export function render(doc: BmlDocument, opts: RenderOptions = {}): string {
  const lang = opts.language ? ` lang="${escapeHtml(opts.language)}"` : "";
  const out: string[] = [`<article class="bml"${lang}>`];
  const ids = matterIds(doc);
  for (const m of doc.frontMatter) {
    out.push(renderMatter(m, doc, opts, "front", ids.get(m)!));
  }
  let partNo = 0;
  const chapterNo = { n: 0 };
  doc.body.forEach((b, i) => {
    // The first body block carries `body-start` too: base.css opens the body
    // on a recto, and no selector can pick it out (Paged.js drops `+`).
    if (b.kind === "part") {
      out.push(renderPart(b, ++partNo, chapterNo, opts, "body", i === 0));
    } else out.push(renderChapter(b, ++chapterNo.n, opts, "body", i === 0));
  });
  for (const m of doc.backMatter) {
    out.push(renderMatter(m, doc, opts, "back", ids.get(m)!));
  }
  out.push(`</article>`);
  return out.join("");
}

// ── segments ────────────────────────────────────────────────────────────────
// One top-level section of the flow. `part` marks a chapter inside that part;
// `opensPart` a part opener, whose section the html leaves open.
interface Piece {
  id: string;
  html: string;
  line: number;
  part?: string;
  opensPart?: string;
}

type Side = Segment["opens"] | null; // null: no forced break, runs on

// A break value as the side it forces, as Paged.js reads it (needsBreakBefore
// breaks on these six only); undefined when the key doesn't set it. Anything
// else (auto, avoid, unset, inherit, revert, a typo) counts as no break: a
// segment merged into the one before lays out as one flow would, where a
// cut the flow doesn't make would not.
function breakSide(v: unknown): Side | undefined {
  if (v === undefined) return undefined;
  switch (String(v).trim().toLowerCase()) {
    case "page":
    case "always":
      return "page";
    case "right":
    case "recto":
      return "right";
    case "left":
    case "verso":
      return "left";
  }
  return null;
}

// `prop` on a section with these classes: the last `elements` key whose
// selector names one of them wins (all one class, so order decides), over
// base.css's zero-specificity rule.
function breakProp(
  cls: Set<string>,
  prop: "break-before" | "break-after",
  elements: Metadata["elements"],
  base: Side,
): Side {
  let side = base;
  for (const [key, style] of Object.entries(elements ?? {})) {
    if (!selectorFor(key).split(", ").some((s) => cls.has(s.slice(1)))) {
      continue;
    }
    const v = breakSide(style[prop]);
    if (v !== undefined) side = v;
  }
  return side;
}

const classesOf = (html: string) =>
  new Set(html.match(/^<section class="([^"]*)"/)?.[1]?.split(" ") ?? []);

// The classes of the endnotes that end a piece (renderBlockWithNotes): after a
// chapter's or a matter block's section, or last in a part's opening content.
const notesClasses = (html: string) =>
  html.match(
    /<aside class="(notes(?: [^"]*)?)">(?:(?!<aside[ >]).)*<\/aside>$/s,
  )
    ?.[1]?.split(" ");

// A forced break-after in a style or any key nested in it.
const forcesAfter = (s: ElementStyle): boolean =>
  !!breakSide(s["break-after"]) ||
  Object.values(s).some((v) => typeof v === "object" && forcesAfter(v));

// Whether a forced break-after could fall on something deeper than a section
// or its endnotes: from a nested key, or a flat one whose selector reaches an
// element they hold (`inner`, the classes inside them, and the article). Last
// in its section, its break lands on the next section (Paged.js's
// displayedElementAfter climbs), a cut renderSegments can't see.
function deepBreakAfter(
  pieces: Piece[],
  elements: Metadata["elements"],
  is: Metadata["is"],
): boolean {
  // {is} blocks only sit inside sections (`<div class="is …">`).
  if (Object.values(is ?? {}).some((s) => breakSide(s["break-after"]))) {
    return true;
  }
  const inner = new Set(["bml"]);
  for (const p of pieces) {
    [...p.html.matchAll(/<(\w+) class="([^"]*)"/g)].slice(1).forEach((m) => {
      const cls = m[2]!.split(" ");
      if (m[1] !== "aside" || !cls.includes("notes")) {
        cls.forEach((c) => inner.add(c));
      }
    });
  }
  return Object.entries(elements ?? {}).some(([key, style]) =>
    Object.values(style).some((v) => typeof v === "object" && forcesAfter(v)) ||
    (!!breakSide(style["break-after"]) &&
      selectorFor(key).split(", ").some((s) =>
        !/^\.[\w-]+$/.test(s) || inner.has(s.slice(1))
      ))
  );
}

// base.css: matter, parts and the body's start on a recto; chapters, the
// copyright page and the colophon on the next page.
function baseOpens(cls: Set<string>): Side {
  return cls.has("part") || cls.has("body-start") ||
      (cls.has("matter") && !cls.has("matter-copyright") &&
        !cls.has("matter-colophon"))
    ? "right"
    : "page";
}

const unescapeHtml = (s: string) =>
  s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const matchAll = (html: string, re: RegExp) => [
  ...new Set([...html.matchAll(re)].map((m) => unescapeHtml(m[1]!))),
];

/** The book cut where pages are forced to break (each section's `opens`),
 * in book order; joined, their sections are render()'s. A chapter in a part
 * sits in a `.part` wrapper marked `data-split-from`, which the page map
 * doesn't count as an opener. `data-line`s stay absolute. */
export function renderSegments(
  doc: BmlDocument,
  opts: RenderOptions = {},
): Segment[] {
  const pieces: Piece[] = [];
  const ids = matterIds(doc);
  const matter = (blocks: MatterBlock[], zone: Zone) => {
    for (const m of blocks) {
      const id = ids.get(m)!;
      pieces.push({
        id,
        line: m.line,
        html: renderMatter(m, doc, opts, zone, id),
      });
    }
  };
  matter(doc.frontMatter, "front");
  let partNo = 0;
  let chapterNo = 0;
  doc.body.forEach((b, i) => {
    if (b.kind === "chapter") {
      pieces.push({
        id: b.slug,
        line: b.line,
        html: renderChapter(b, ++chapterNo, opts, "body", i === 0),
      });
      return;
    }
    pieces.push({
      id: b.slug,
      line: b.line,
      opensPart: b.slug,
      html: partOpener(b, ++partNo, opts, "body", i === 0),
    });
    for (const ch of partChapters(b)) {
      pieces.push({
        id: ch.slug,
        line: ch.line,
        part: b.slug,
        html: renderChapter(ch, ++chapterNo, opts),
      });
    }
  });
  matter(doc.backMatter, "back");

  const groups: { opens: Segment["opens"]; pieces: Piece[] }[] = [];
  // ponytail: a deep forced break-after merges the whole book into one
  // segment; check whether the previous piece ends in what it reaches if such
  // books need the speed.
  const deep = deepBreakAfter(pieces, opts.elements, opts.is);
  let after: Side = null; // the previous section's break-after
  let partAfter: Side = null; // the open part's, owed where the part ends
  for (const p of pieces) {
    const cls = classesOf(p.html);
    if (p.part === undefined) [after, partAfter] = [after ?? partAfter, null];
    const before = breakProp(
      cls,
      "break-before",
      opts.elements,
      baseOpens(cls),
    );
    // A forced side beats a plain page break, from either end.
    const opens = before && before !== "page" ? before : after ?? before;
    // Paged.js puts a break-after before the next displayed element: the
    // section's lands on its endnotes, when it has some, and theirs on the
    // next piece. A part's waits for the part's end.
    const own = breakProp(cls, "break-after", opts.elements, null);
    const notes = notesClasses(p.html);
    const notesAfter = notes
      ? breakProp(new Set(notes), "break-after", opts.elements, null)
      : null;
    if (p.opensPart) [partAfter, after] = [own, notesAfter];
    else after = notes ? notesAfter : own;
    const last = groups.at(-1);
    if ((deep || !opens) && last) last.pieces.push(p);
    else groups.push({ opens: opens ?? "page", pieces: [p] });
  }

  const lang = opts.language ? ` lang="${escapeHtml(opts.language)}"` : "";
  return groups.map(({ opens, pieces }) => {
    let body = "";
    let inPart: string | undefined; // the part whose section is open
    for (const p of pieces) {
      if (inPart !== undefined && p.part !== inPart) body += "</section>";
      if (p.part !== undefined && p.part !== inPart) {
        body += `<section class="part zone-body" data-split-from="${
          escapeHtml(p.part)
        }">`;
      }
      body += p.html;
      inPart = p.opensPart ?? p.part;
    }
    if (inPart !== undefined) body += "</section>";
    const first = pieces[0]!;
    return {
      id: first.id,
      html: `<article class="bml"${lang}>${body}</article>`,
      line: first.line,
      opens,
      reads: matchAll(body, /<a class="(?:page|ref)" href="#([^"]*)"/g),
      ids: matchAll(body, / id="([^"]*)"/g),
    };
  });
}
