// parser/inline.ts — inline-level parsing for one paragraph (spec §3.2.6–§3.2.8).
import type { Inline } from "./types.ts";

const POINT_RE = /^(footnote|ref):\s*(.+)$/;

export function parseInlines(lines: string[]): Inline[] {
  // Resolve per-line end-of-line escapes first.
  const parts: { text: string; hardBreak: boolean }[] = [];
  for (const raw of lines) {
    let l = raw.startsWith("\\") ? raw.slice(1) : raw;
    let hardBreak = false;
    if (l.endsWith("\\\\")) {
      l = l.slice(0, -2) + "\\"; // literal backslash, normal join
    } else if (l.endsWith("\\")) {
      l = l.slice(0, -1);
      hardBreak = true;
    }
    parts.push({ text: l, hardBreak });
  }

  const root: Inline[] = [];
  const stack: Inline[][] = [root];
  let buf = "";
  const top = () => stack[stack.length - 1]!;
  const flush = () => {
    if (buf) {
      top().push({ kind: "text", text: buf });
      buf = "";
    }
  };

  parts.forEach((part, pi) => {
    if (pi > 0) {
      if (parts[pi - 1]!.hardBreak) {
        flush();
        top().push({ kind: "linebreak" });
      } else {
        buf += " ";
      }
    }
    const s = part.text;
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\" && i + 1 < s.length) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "{") {
        const close = s.indexOf("}", i);
        if (close !== -1) {
          const tag = s.slice(i + 1, close).trim();
          if (tag === "em") {
            flush();
            const children: Inline[] = [];
            top().push({ kind: "em", children });
            stack.push(children);
            i = close + 1;
            continue;
          }
          if (tag === "/em") {
            flush();
            if (stack.length > 1) stack.pop();
            i = close + 1;
            continue;
          }
          const m = tag.match(POINT_RE);
          if (m) {
            flush();
            top().push({ kind: m[1] as "footnote" | "ref", slug: m[2]!.trim() });
            i = close + 1;
            continue;
          }
        }
      }
      buf += ch;
      i++;
    }
  });
  flush();
  return root;
}
