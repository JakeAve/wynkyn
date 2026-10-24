// server/import/docx.ts — a Word document into blocks (spec §7.9), for files
// saved from Word or downloaded from Google Docs (File → Download → .docx).
// `word/document.xml` paragraphs by style: headings (by the built-in "heading
// N" name or an outline level, through `basedOn`), Title, quotes, TOC entries;
// italic runs as `{em}`; soft line breaks as verse; footnotes and endnotes as
// `{footnote}` anchors with a note after the paragraph; pictures from
// `word/media`. Title and author from `docProps/core.xml`.
import { strFromU8, type Unzipped } from "fflate";
import { balanceEm, type Block, esc, type Source } from "./blocks.ts";
import { BREAK } from "./text.ts";
import { textOf, type Tok, tokenize } from "./xml.ts";

interface Style {
  name: string;
  basedOn?: string;
  outline?: number;
  italic?: boolean;
  bold?: boolean;
  size?: number; // half-points
}

interface Para {
  style?: string;
  outline?: number;
  owner?: string; // the footnote or endnote holding it, as `fn-3` / `en-3`
  text: string; // BML inline text, `\n` at soft line breaks
  images: { rel: string; alt: string }[];
  notes: string[]; // slugs anchored in it
  size: number; // the largest text run's, in half-points; 0 when unset
  bold: boolean; // every text run bold
}

const on = (t: Tok) =>
  t.type === "open" && !["0", "false", "off"].includes(t.attrs["w:val"] ?? "");

// Text boxes nest paragraphs inside a paragraph, and a Fallback repeats its
// Choice; neither is the body text.
const SKIP = new Set(["w:tbl", "w:txbxcontent", "mc:fallback", "w:movefrom"]);

function styles(xml: string | undefined): Map<string, Style> {
  const out = new Map<string, Style>();
  let cur: Style | null = null;
  for (const t of tokenize(xml ?? "")) {
    if (t.type === "open" && t.name === "w:style") {
      cur = { name: "" };
      out.set(t.attrs["w:styleid"] ?? "", cur);
    } else if (t.type === "close" && t.name === "w:style") cur = null;
    else if (cur && t.type === "open") {
      if (t.name === "w:name") cur.name = t.attrs["w:val"] ?? "";
      else if (t.name === "w:basedon") cur.basedOn = t.attrs["w:val"];
      else if (t.name === "w:outlinelvl") {
        cur.outline = Number(t.attrs["w:val"]);
      } else if (t.name === "w:i") cur.italic = on(t);
      else if (t.name === "w:b") cur.bold = on(t);
      else if (t.name === "w:sz") cur.size = Number(t.attrs["w:val"]) || 0;
    }
  }
  return out;
}

/** Every paragraph of a document part, in order. */
function paragraphs(xml: string, sty: Map<string, Style>): Para[] {
  const out: Para[] = [];
  let p: Para | null = null;
  let owner: string | undefined;
  let skip = 0, inT = false, italic = false, run = "";
  let bold: boolean | undefined, size: number | undefined;
  /** A paragraph style's property, through `basedOn`. */
  const inherit = <K extends "bold" | "size">(id = "", k: K) => {
    for (
      let s = sty.get(id), i = 0;
      s && i < 10;
      s = sty.get(s.basedOn ?? "")
    ) {
      if (s[k] !== undefined) return s[k];
      i++;
    }
  };
  const endRun = () => {
    if (!p || !run) return;
    if (run.replace(/\{footnote: [^}]*\}/g, "").trim()) {
      p.size = Math.max(p.size, size ?? inherit(p.style, "size") ?? 0);
      p.bold &&= bold ?? inherit(p.style, "bold") ?? false;
      p.text += italic ? `{em}${run}{/em}` : run;
    } else p.text += run;
    run = "";
  };
  for (const t of tokenize(xml)) {
    if (t.type === "text") {
      if (inT && !skip) run += esc(t.text);
      continue;
    }
    const n = t.name;
    if (SKIP.has(n)) {
      if (t.type === "open" && !t.self) skip++;
      else if (t.type === "close") skip = Math.max(0, skip - 1);
      continue;
    }
    if (skip) continue;
    if (t.type === "close") {
      if (n === "w:t") inT = false;
      else if (n === "w:r") endRun();
      else if (n === "w:p" && p) {
        endRun();
        out.push(p);
        p = null;
      }
      continue;
    }
    const a = t.attrs;
    if (n === "w:footnote" || n === "w:endnote") {
      owner = `${n === "w:footnote" ? "fn" : "en"}-${a["w:id"]}`;
    } else if (n === "w:p") {
      p = { owner, text: "", images: [], notes: [], size: 0, bold: true };
    } else if (!p) continue;
    else if (n === "w:pstyle") p.style = a["w:val"];
    else if (n === "w:outlinelvl") p.outline = Number(a["w:val"]);
    else if (n === "w:r") {
      italic = false, run = "", bold = undefined, size = undefined;
    } else if (n === "w:rstyle") {
      const s = sty.get(a["w:val"] ?? "");
      italic = !!s?.italic || /emphasis/i.test(s?.name ?? "");
    } else if (n === "w:i") italic = on(t);
    else if (n === "w:b") bold = on(t);
    else if (n === "w:sz") size = Number(a["w:val"]) || 0;
    else if (n === "w:t" && !t.self) inT = true;
    else if (n === "w:tab") run += " ";
    else if ((n === "w:br" && !a["w:type"]) || n === "w:cr") run += "\n";
    else if (n === "w:footnotereference" || n === "w:endnotereference") {
      const slug = `${n === "w:footnotereference" ? "fn" : "en"}-${a["w:id"]}`;
      run += `{footnote: ${slug}}`;
      p.notes.push(slug);
    } else if (n === "wp:docpr") {
      p.images.push({ rel: "", alt: a.descr || a.title || "" });
    } else if (n === "a:blip" || n === "v:imagedata") {
      const rel = a["r:embed"] ?? a["r:id"] ?? "";
      const last = p.images.at(-1);
      if (last && !last.rel) last.rel = rel;
      else p.images.push({ rel, alt: a["o:title"] ?? "" });
    }
  }
  return out;
}

export function readDocx(name: string, files: Unzipped): Source {
  const text = (p: string) => files[p] ? strFromU8(files[p]!) : undefined;
  const sty = styles(text("word/styles.xml"));
  const core = tokenize(text("docProps/core.xml") ?? "");
  const src: Source = {
    name,
    title: textOf(core, "dc:title") || undefined,
    author: textOf(core, "dc:creator") || undefined,
    tocTitles: [],
    blocks: [],
    images: {},
  };

  const rels = new Map<string, string>();
  for (const t of tokenize(text("word/_rels/document.xml.rels") ?? "")) {
    if (t.type === "open" && t.name === "relationship" && t.attrs.id) {
      rels.set(t.attrs.id, t.attrs.target ?? "");
    }
  }

  const notes = new Map<string, string>();
  for (const part of ["word/footnotes.xml", "word/endnotes.xml"]) {
    for (const p of paragraphs(text(part) ?? "", sty)) {
      const body = p.text.replace(/\s+/g, " ").trim();
      if (!p.owner || !body) continue;
      const had = notes.get(p.owner);
      notes.set(p.owner, had ? `${had} ${body}` : body);
    }
  }

  /** The paragraph's style names down its `basedOn` chain, lower case, and
   * its heading level (0 for none). */
  const kind = (p: Para) => {
    let level = p.outline;
    let s = sty.get(p.style ?? "");
    const names = s ? [] : [(p.style ?? "").toLowerCase()];
    for (let i = 0; s && i < 10; i++, s = sty.get(s.basedOn ?? "")) {
      names.push(s.name.toLowerCase());
      const h = s.name.match(/^heading (\d)$/i);
      if (level === undefined && h) level = Number(h[1]) - 1;
      level ??= s.outline;
    }
    const is = (re: RegExp) => names.some((n) => re.test(n));
    return { is, level: level !== undefined && level < 9 ? level + 1 : 0 };
  };

  // A document with no heading styles marked its headings by hand: a short
  // line set larger than the body text, the largest size first, or in bold.
  const paras = paragraphs(text("word/document.xml") ?? "", sty);
  const length = (p: Para) =>
    p.text.replace(/\{\/?em\}|\{footnote: [^}]*\}/g, "").trim().length;
  let byLook = (_: Para) => 0;
  if (!paras.some((p) => kind(p).level)) {
    const chars = new Map<number, number>();
    for (const p of paras) {
      chars.set(p.size, (chars.get(p.size) ?? 0) + length(p));
    }
    const body = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const larger = [...chars.keys()].filter((s) => s > body).sort((a, b) =>
      b - a
    );
    byLook = (p) => {
      const n = length(p);
      if (!n || n > 100 || p.text.includes("\n")) return 0;
      if (p.size > body) return larger.indexOf(p.size) + 1;
      return p.bold ? larger.length + 1 : 0;
    };
  }

  let titleStyled: string | undefined;
  let toc = false;
  for (const p of paras) {
    for (const im of p.images) {
      const target = rels.get(im.rel);
      const data = target && files[`word/${target.replace(/^\/?word\//, "")}`];
      if (!target || !data) continue;
      const src_ = target.slice(target.lastIndexOf("/") + 1);
      src.images[src_] = data;
      // Word's own guess ("A picture containing… Description automatically
      // generated") is no caption.
      const alt = /automatically generated/i.test(im.alt) ? "" : im.alt.trim();
      src.blocks.push({ kind: "image", src: src_, alt: esc(alt) });
    }
    const lines = p.text.split("\n").map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.replace(/\{\/?em\}/g, ""));
    if (!lines.length) continue;
    const joined = lines.join(" ").replace(/\{\/em\}(\s*)\{em\}/g, "$1");
    const { is, level: styled } = kind(p);
    const level = styled || byLook(p);
    let b: Block;
    if (is(/^toc/)) {
      // Word's own contents list: drop it, once.
      if (!toc && !is(/^toc heading$/)) src.blocks.push({ kind: "toc" });
      toc = true;
      continue;
    } else if (is(/^title$/)) {
      titleStyled ??= joined.replace(/\{\/?em\}/g, "");
      b = { kind: "para", text: joined };
    } else if (level) {
      // ponytail: a note on a heading is dropped with its anchor
      const text = joined.replace(/\{footnote: [^}]*\}/g, "");
      b = { kind: "heading", level, text };
    } else if (BREAK.test(joined)) b = { kind: "break" };
    else if (lines.length >= 2) b = { kind: "verse", lines: balanceEm(lines) };
    else if (is(/quote|block text/)) b = { kind: "quote", text: joined };
    else b = { kind: "para", text: joined };
    src.blocks.push(b);
    if (b.kind === "heading") continue;
    for (const slug of p.notes) {
      const body = notes.get(slug);
      if (body) src.blocks.push({ kind: "note", slug, text: body });
    }
  }
  // What the author typed in the Title style beats a stale document property.
  if (titleStyled) src.title = titleStyled;
  return src;
}
