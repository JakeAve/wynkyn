// renderer/render.ts — BmlDocument → semantic HTML (spec §5.3). Pure, no I/O.
import { DISPLAY_MATTER } from "../parser/types.ts";
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
  NotesConfig,
  Numbering,
  NumberingStyle,
  TocConfig,
} from "../metadata/types.ts";

export interface RenderOptions {
  numbering?: Numbering;
  notes?: NotesConfig;
  toc?: TocConfig;
  images?: Record<string, string>; // slug → relative path; resolved by the caller
}

export function formatNumber(n: number, style: NumberingStyle): string {
  switch (style) {
    case "roman-upper":
      return toRoman(n);
    case "roman-lower":
      return toRoman(n).toLowerCase();
    case "alpha-upper":
      return toAlpha(n);
    case "alpha-lower":
      return toAlpha(n).toLowerCase();
    case "words":
      return toWords(n);
    case "none":
      return "";
    default:
      return String(n);
  }
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  for (const [v, s] of table) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

function toAlpha(n: number): string {
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

// ponytail: spelled numbers stop at 99; a book with a hundred chapters gets digits.
function toWords(n: number): string {
  if (n < 1 || n >= 100) return String(n);
  if (n < 20) return ONES[n] ?? String(n);
  const tens = TENS[Math.floor(n / 10)] ?? "";
  const ones = ONES[n % 10] ?? "";
  return ones ? `${tens}-${ones}` : tens;
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  )
    .replaceAll('"', "&quot;");
}

// ── note machinery ──────────────────────────────────────────────────────────
interface NoteCtx {
  placement: "footnote" | "endnote";
  notes: Map<string, Note>;
  used: string[]; // slugs in anchor order
}

function collectNotes(nodes: ContentNode[], map: Map<string, Note>): void {
  for (const n of nodes) {
    if (n.kind === "note") map.set(n.slug, n);
    else if ("children" in n && Array.isArray(n.children)) {
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
        ctx.used.push(i.slug);
        const n = ctx.used.length;
        const note = ctx.notes.get(i.slug);
        if (ctx.placement === "footnote" && note) {
          out +=
            `<sup class="footnote-anchor" id="fnref-${
              escapeHtml(i.slug)
            }">${n}</sup>` +
            `<span class="note" id="note-${escapeHtml(i.slug)}">${
              renderInlines(note.inlines, ctx)
            }</span>`;
        } else {
          out += `<sup class="footnote-anchor" id="fnref-${
            escapeHtml(i.slug)
          }"><a href="#note-${escapeHtml(i.slug)}">${n}</a></sup>`;
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
  const initial = src
    ? `<img class="dropcap" src="${src}" alt="">${
      renderInlines(node.inlines, ctx)
    }`
    : (() => {
      const { head, rest } = splitFirstChar(node.inlines);
      return `<span class="dropcap">${escapeHtml(head)}</span>${
        renderInlines(rest, ctx)
      }`;
    })();
  return `<p class="has-dropcap${extraClass}">${prefix}${initial}</p>`;
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
// A paragraph directly after a title or a break carries no indent. That used to
// be `h1 + p` / `.break + p` in base.css, but Paged.js drops `+` rules whole
// (docs/pagedjs-plus-combinator.md), so the class is decided here.
function opensBlock(prev: ContentNode | undefined): boolean {
  return prev?.kind === "break" ||
    (prev?.kind === "component" && prev.name === "title");
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
      return `<p${lead ? ' class="lead"' : ""}>${
        renderInlines(node.inlines, ctx)
      }</p>`;
    case "component": {
      if (node.name === "title") {
        return `<h1 class="title">${renderInlines(node.inlines, ctx)}</h1>`;
      }
      return `<p class="${node.name}">${renderInlines(node.inlines, ctx)}</p>`;
    }
    case "dropcap":
      return dropcapHtml(node, ctx, opts);
    case "heading": {
      const tag = node.level === 1 ? "h3" : "h4";
      const cls = node.level === 1 ? "heading" : "subheading";
      const id = node.slug ? ` id="${escapeHtml(node.slug)}"` : "";
      return `<${tag} class="${cls}"${id}>${
        renderInlines(node.inlines, ctx)
      }</${tag}>`;
    }
    case "break":
      return `<div class="break${
        node.slug ? ` break-${escapeHtml(node.slug)}` : ""
      }"></div>`;
    case "epigraph":
    case "quote": {
      const inner = node.children.map((c) =>
        c.kind === "paragraph"
          ? `<p class="text">${renderInlines(c.inlines, ctx)}</p>`
          : renderContent(c, ctx, opts)
      ).join("");
      return `<blockquote class="${node.kind}">${inner}${
        attribution(node.attribution, ctx)
      }</blockquote>`;
    }
    case "pullquote": {
      const inner = renderChildren(node.children, ctx, opts);
      return `<aside class="pullquote">${inner}${
        attribution(node.attribution, ctx)
      }</aside>`;
    }
    case "poem": {
      const stanzas = node.stanzas.map((s) =>
        s.kind === "paragraph"
          ? `<p class="stanza">${renderInlines(s.inlines, ctx)}</p>`
          : ""
      ).join("");
      return `<div class="poem">${stanzas}${
        attribution(node.attribution, ctx)
      }</div>`;
    }
    case "sidebar":
      return `<aside class="sidebar">${
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
          : `<p class="verse">${num}${renderInlines(v.inlines, ctx)}</p>`;
      }).join("");
      return `<div class="verses" id="${
        escapeHtml(node.slug)
      }">${verses}</div>`;
    }
    case "columns": {
      if (node.mode === "flow") {
        const inner = renderChildren(node.columns[0] ?? [], ctx, opts);
        return `<div class="columns columns-flow" style="column-count: ${node.count}">${inner}</div>`;
      }
      const cols = node.columns.map((col) =>
        `<div class="col">${renderChildren(col, ctx, opts)}</div>`
      ).join("");
      return `<div class="columns columns-parallel" style="grid-template-columns: repeat(${node.count}, 1fr)">${cols}</div>`;
    }
    case "is":
      return `<div class="is-${escapeHtml(node.className)}">${
        renderChildren(node.children, ctx, opts)
      }</div>`;
    case "illustration": {
      const cls = `illustration${
        node.placement ? ` placement-${node.placement}` : ""
      }`;
      const captionText = node.caption ? inlinePlainText(node.caption) : "";
      const src = opts.images?.[node.slug];
      const media = src
        ? `<img src="${src}" alt="${escapeHtml(captionText)}">`
        : `<div class="illustration-placeholder">[illustration: ${
          escapeHtml(node.slug)
        }]</div>`;
      const cap = node.caption
        ? `<figcaption class="caption">${
          renderInlines(node.caption, ctx)
        }</figcaption>`
        : "";
      return `<figure class="${cls}" id="${
        escapeHtml(node.slug)
      }">${media}${cap}</figure>`;
    }
    case "list": {
      const items = node.items.map((it) => `<li>${renderInlines(it, ctx)}</li>`)
        .join("");
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
    ? `<p class="attribution">${renderInlines(attr.inlines, ctx)}</p>`
    : "";
}

// ── structural rendering ────────────────────────────────────────────────────
function renderBlockWithNotes(
  children: ContentNode[],
  opts: RenderOptions,
  body: (ctx: NoteCtx) => string,
): string {
  const ctx: NoteCtx = {
    placement: opts.notes?.placement ?? "endnote",
    notes: new Map(),
    used: [],
  };
  collectNotes(children, ctx.notes);
  let html = body(ctx);
  if (ctx.placement === "endnote") {
    const slugs = [
      ...ctx.used,
      ...[...ctx.notes.keys()].filter((s) => !ctx.used.includes(s)),
    ];
    if (slugs.length && ctx.notes.size) {
      const rendered = slugs
        .filter((s, i) => slugs.indexOf(s) === i && ctx.notes.has(s))
        .map((s, i) =>
          `<div class="note" id="note-${escapeHtml(s)}"><sup>${i + 1}</sup> ${
            renderInlines(ctx.notes.get(s)!.inlines, ctx)
          }</div>`
        ).join("");
      if (rendered) html += `<aside class="notes">${rendered}</aside>`;
    }
  }
  return html;
}

function numberText(
  n: number,
  cfg: {
    style?: NumberingStyle;
    show?: boolean;
    prefix?: string;
    suffix?: string;
  } | undefined,
): string {
  if (!cfg || cfg.show === false || !cfg.style || cfg.style === "none") {
    return "";
  }
  return `${cfg.prefix ?? ""}${formatNumber(n, cfg.style)}${cfg.suffix ?? ""}`;
}

function numberDiv(
  n: number,
  cfg: {
    style?: NumberingStyle;
    show?: boolean;
    prefix?: string;
    suffix?: string;
  } | undefined,
): string {
  const t = numberText(n, cfg);
  return t ? `<div class="number">${escapeHtml(t)}</div>` : "";
}

function renderChapter(ch: Chapter, n: number, opts: RenderOptions): string {
  return renderBlockWithNotes(ch.children, opts, (ctx) => {
    const inner = renderChildren(ch.children, ctx, opts);
    return `<section class="chapter" id="${escapeHtml(ch.slug)}">${
      numberDiv(n, opts.numbering?.chapters)
    }${inner}</section>`;
  });
}

// Raw (unescaped) id — callers escape once at their own interpolation site
// (renderMatter into id="…", tocRow into href="#…") so it isn't double-escaped.
function matterId(m: MatterBlock): string {
  return `matter-${m.type}${m.label ? `-${m.label.toLowerCase()}` : ""}`;
}

function renderMatter(
  m: MatterBlock,
  doc: BmlDocument,
  opts: RenderOptions,
): string {
  const id = escapeHtml(matterId(m));
  const open = `<section class="matter matter-${
    escapeHtml(m.type)
  }" id="${id}">`;
  if (m.type === "toc") {
    const onlyTitles = m.children.every((c) =>
      c.kind === "component" && c.name === "title"
    );
    if (onlyTitles) {
      return renderBlockWithNotes(m.children, opts, (ctx) => {
        const title = renderChildren(m.children, ctx, opts);
        return `${open}${title}${generateToc(doc, opts)}</section>`;
      });
    }
  }
  return renderBlockWithNotes(m.children, opts, (ctx) => {
    const inner = renderChildren(m.children, ctx, opts);
    return `${open}${inner}</section>`;
  });
}

interface TocRow {
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

function generateToc(doc: BmlDocument, opts: RenderOptions): string {
  const rows: string[] = [];
  const matterRows = (blocks: MatterBlock[], cls: string) => {
    for (const m of blocks) {
      if (DISPLAY_MATTER.has(m.type)) continue;
      const label = titleOf(m.children);
      if (label) rows.push(tocRow({ cls, href: matterId(m), label }));
    }
  };
  matterRows(doc.frontMatter, "toc-front");

  let partNo = 0;
  let chapterNo = 0;
  const chapterRow = (ch: Chapter, inPart: boolean) => {
    const number = numberText(++chapterNo, opts.numbering?.chapters);
    rows.push(tocRow({
      cls: `toc-chapter${inPart ? " in-part" : ""}`,
      href: ch.slug,
      label: titleOf(ch.children) ?? (number ? "" : ch.slug),
      number,
      subtitle: componentText(ch.children, "subtitle"),
    }));
    if (opts.toc?.headings) {
      for (const c of ch.children) {
        if (c.kind === "heading" && c.level === 1 && c.slug) {
          rows.push(tocRow({
            cls: `toc-heading${inPart ? " in-part" : ""}`,
            href: c.slug,
            label: inlinePlainText(c.inlines),
          }));
        }
      }
    }
  };
  for (const b of doc.body) {
    if (b.kind === "part") {
      const number = numberText(++partNo, opts.numbering?.parts);
      rows.push(tocRow({
        cls: "toc-part",
        href: b.slug,
        label: titleOf(b.children) ?? (number ? "" : b.slug),
        number,
        subtitle: componentText(b.children, "subtitle"),
      }));
      for (const c of b.children) if (c.kind === "chapter") chapterRow(c, true);
    } else {
      chapterRow(b, false);
    }
  }
  matterRows(doc.backMatter, "toc-back");
  return `<nav class="toc">${rows.join("")}</nav>`;
}

function renderPart(
  part: Part,
  partNo: number,
  chapterNo: { n: number },
  opts: RenderOptions,
): string {
  const contentKids = part.children.filter((c) =>
    c.kind !== "chapter"
  ) as ContentNode[];
  const head = renderBlockWithNotes(
    contentKids,
    opts,
    (ctx) => renderChildren(contentKids, ctx, opts),
  );
  const chapters = part.children
    .filter((c): c is Chapter => c.kind === "chapter")
    .map((ch) => renderChapter(ch, ++chapterNo.n, opts))
    .join("");
  return `<section class="part" id="${escapeHtml(part.slug)}">${
    numberDiv(partNo, opts.numbering?.parts)
  }${head}${chapters}</section>`;
}

export function render(doc: BmlDocument, opts: RenderOptions = {}): string {
  const out: string[] = [`<article class="bml">`];
  if (doc.frontMatter.length) {
    out.push(`<div class="zone zone-front">`);
    for (const m of doc.frontMatter) out.push(renderMatter(m, doc, opts));
    out.push(`</div>`);
  }
  if (doc.body.length) {
    out.push(`<div class="zone zone-body">`);
    let partNo = 0;
    const chapterNo = { n: 0 };
    for (const b of doc.body) {
      if (b.kind === "part") out.push(renderPart(b, ++partNo, chapterNo, opts));
      else out.push(renderChapter(b, ++chapterNo.n, opts));
    }
    out.push(`</div>`);
  }
  if (doc.backMatter.length) {
    out.push(`<div class="zone zone-back">`);
    for (const m of doc.backMatter) out.push(renderMatter(m, doc, opts));
    out.push(`</div>`);
  }
  out.push(`</article>`);
  return out.join("");
}
