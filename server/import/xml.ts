// server/import/xml.ts — a small tolerant tag tokenizer for XHTML, OPF and
// nav documents. Enough for EPUB and saved web pages in both Deno and the
// browser; no DOM, no dependency.
// ponytail: a regex tokenizer, not an HTML5 parser. Unclosed tags and sloppy
// markup are handled by the walker ignoring what it does not know; swap in
// DOMParser if real-world pages break it.

export type Tok =
  | { type: "open"; name: string; attrs: Record<string, string>; self: boolean }
  | { type: "close"; name: string }
  | { type: "text"; text: string };

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  copy: "©",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
};

export function decode(t: string): string {
  return t.replace(
    /&(#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (m, _a, hex, dec, name) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return NAMED[name.toLowerCase()] ?? m;
    },
  );
}

const ATTR = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const RAW = new Set(["script", "style"]);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out.push({ type: "text", text: decode(src.slice(i)) });
      break;
    }
    if (lt > i) out.push({ type: "text", text: decode(src.slice(i, lt)) });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const end = src.indexOf(">", lt);
    if (end < 0) break;
    const body = src.slice(lt + 1, end);
    i = end + 1;
    if (body.startsWith("/")) {
      out.push({ type: "close", name: body.slice(1).trim().toLowerCase() });
      continue;
    }
    const self = body.endsWith("/");
    const inner = self ? body.slice(0, -1) : body;
    const sp = inner.search(/[\s\/]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).toLowerCase();
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      for (const m of inner.slice(sp).matchAll(ATTR)) {
        attrs[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
      }
    }
    out.push({ type: "open", name, attrs, self });
    if (!self && RAW.has(name)) {
      const close = src.indexOf(`</${name}`, i);
      i = close < 0 ? n : src.indexOf(">", close) + 1;
    }
  }
  return out;
}

/** Text content of the first `<name>` element, for OPF metadata. */
export function textOf(toks: Tok[], name: string): string | undefined {
  let depth = 0;
  let buf = "";
  for (const t of toks) {
    if (t.type === "open" && t.name === name && !t.self) depth++;
    else if (depth && t.type === "close" && t.name === name) return buf.trim();
    else if (depth && t.type === "text") buf += t.text;
  }
  return undefined;
}
