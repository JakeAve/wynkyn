// server/import/html.ts — an (X)HTML document into blocks (spec §7.9), shared
// by the EPUB reader and saved web pages. h1–h6 are headings, p paragraphs,
// pre and br-separated p verse, blockquote quotes, hr breaks, img images,
// i/em/cite emphasis. Everything else is transparent.
import { balanceEm, type Block, esc, squash, verseLines } from "./blocks.ts";
import { tokenize } from "./xml.ts";

const HEADING = /^h([1-6])$/;
const EM = new Set(["i", "em", "cite"]);
const SKIP = new Set(["head", "title", "nav", "sup", "sub", "table"]);
const BLOCK_OPEN = new Set([
  "p",
  "pre",
  "li",
  "div",
  "blockquote",
  "body",
  "section",
  "article",
  "figure",
  "figcaption",
  "dd",
  "dt",
  "td",
]);

export function readHtml(src: string): { title?: string; blocks: Block[] } {
  const blocks: Block[] = [];
  let title: string | undefined;
  type Cur = { kind: "heading" | "para" | "pre"; level: number; text: string };
  const st = { cur: null as Cur | null }; // a holder: closures assign it
  let quote = 0;
  let em = 0;
  let skip = 0;
  let titleBuf: string | null = null;

  const flush = () => {
    if (!st.cur) return;
    const c = st.cur;
    st.cur = null;
    while (em > 0) {
      c.text += "{/em}";
      em--;
    }
    if (c.kind === "pre") {
      for (const stanza of c.text.split(/\n\s*\n/)) {
        const lines = balanceEm(verseLines(stanza.split("\n")));
        if (lines.length) blocks.push({ kind: "verse", lines });
      }
      return;
    }
    const parts = c.text.split("\n").map(squash).filter(Boolean);
    if (!parts.length) return;
    if (c.kind === "heading") {
      blocks.push({ kind: "heading", level: c.level, text: parts.join(" ") });
    } else if (parts.length >= 2) {
      blocks.push({ kind: "verse", lines: balanceEm(parts) });
    } else if (quote) {
      blocks.push({ kind: "quote", text: parts[0]! });
    } else blocks.push({ kind: "para", text: parts[0]! });
  };
  const start = (kind: "heading" | "para" | "pre", level = 0) => {
    flush();
    st.cur = { kind, level, text: "" };
  };

  for (const t of tokenize(src)) {
    if (t.type === "text") {
      if (titleBuf !== null) titleBuf += t.text;
      else if (skip) continue;
      else {
        if (!st.cur && t.text.trim()) start("para");
        if (st.cur) {
          st.cur.text += esc(
            st.cur.kind === "pre" ? t.text : t.text.replace(/\s+/g, " "),
          );
        }
      }
      continue;
    }
    const name = t.name;
    if (t.type === "open") {
      if (name === "title") {
        titleBuf = "";
        continue;
      }
      if (SKIP.has(name) && !t.self) {
        skip++;
        continue;
      }
      if (skip) continue;
      const h = name.match(HEADING);
      if (h) start("heading", parseInt(h[1]!, 10));
      else if (name === "pre") start("pre");
      else if (
        name === "p" || name === "li" || name === "figcaption" ||
        name === "dd" || name === "dt"
      ) start("para");
      else if (name === "blockquote") {
        flush();
        quote++;
      } else if (name === "br") {
        if (st.cur) st.cur.text += "\n";
      } else if (name === "hr") {
        flush();
        blocks.push({ kind: "break" });
      } else if (name === "img") {
        const inHeading = st.cur?.kind === "heading";
        if (!inHeading) flush();
        if (t.attrs.src) {
          blocks.push({
            kind: "image",
            src: t.attrs.src,
            alt: squash(esc(t.attrs.alt ?? "")),
          });
        }
      } else if (EM.has(name) && st.cur) {
        st.cur.text += "{em}";
        em++;
      } else if (BLOCK_OPEN.has(name)) flush();
    } else {
      if (name === "title") {
        title = squash(titleBuf ?? "");
        titleBuf = null;
        continue;
      }
      if (SKIP.has(name)) {
        if (skip) skip--;
        continue;
      }
      if (skip) continue;
      if (
        HEADING.test(name) || name === "p" || name === "pre" || name === "li" ||
        name === "figcaption" || name === "dd" || name === "dt"
      ) flush();
      else if (name === "blockquote") {
        flush();
        quote = Math.max(0, quote - 1);
      } else if (EM.has(name) && st.cur && em > 0) {
        st.cur.text += "{/em}";
        em--;
      } else if (BLOCK_OPEN.has(name)) flush();
    }
  }
  flush();
  return { title, blocks };
}
