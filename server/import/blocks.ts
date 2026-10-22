// server/import/blocks.ts — what every reader hands the structure step (spec
// §7.9): a flat stream of blocks, plus whatever the file said about itself.
// Prose in blocks is already BML inline text: `{em}…{/em}` for emphasis, a
// literal brace escaped as `\{`.

export type Block =
  & (
    | { kind: "heading"; level: number; text: string; sub?: string }
    | { kind: "para"; text: string }
    | { kind: "verse"; lines: string[] } // one stanza
    | { kind: "quote"; text: string }
    | { kind: "break" }
    | { kind: "image"; src: string; alt: string }
    | { kind: "toc" } // the source's contents list, dropped later
  )
  & { check?: string }; // a `%% check:` note the structure step attaches

export interface Source {
  name: string; // the file's name, for the summary comment
  title?: string;
  author?: string;
  year?: string;
  gutenberg?: string; // eBook number when the file came from Project Gutenberg
  tocTitles: string[]; // the file's own navigation, when it has one
  blocks: Block[];
  images: Record<string, Uint8Array>; // by the `src` the image blocks use
}

/** Literal braces must not read as sentinels. */
export const esc = (t: string): string => t.replace(/\{/g, "\\{");

export const squash = (t: string): string => t.replace(/\s+/g, " ").trim();

/** Letters and digits only, lower case: how two headings are compared. */
export const norm = (t: string): string =>
  t.toLowerCase().replace(/\{\/?em\}/g, "").replace(/[^a-z0-9]+/g, "");

/** Verse lines from raw source lines: a line indented deeper than the first is
 * the continuation of the line before it (how Gutenberg wraps long verse). */
export function verseLines(raw: string[]): string[] {
  const lines = raw.filter((l) => l.trim());
  if (!lines.length) return [];
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = Math.min(...lines.map(indent));
  const out: string[] = [];
  for (const l of lines) {
    if (out.length && indent(l) > base + 2) {
      out[out.length - 1] += " " + l.trim();
    } else out.push(l.trim());
  }
  return out;
}

/** `{em}` must open and close on one line (spec §3.2.7): a span that runs
 * across verse lines is closed at each line end and reopened on the next. */
export function balanceEm(lines: string[]): string[] {
  let open = 0;
  const out: string[] = [];
  for (const raw of lines) {
    let l = raw.replace(/^\{\/em\}\s*/, () => {
      open = Math.max(0, open - 1);
      return "";
    });
    const prefix = "{em}".repeat(open);
    for (const m of l.matchAll(/\{(\/?)em\}/g)) open += m[1] ? -1 : 1;
    open = Math.max(0, open);
    l = (prefix + l).replace(/\s*\{em\}\s*$/, () => {
      open--;
      return "";
    });
    if (!l.replace(/\{\/?em\}/g, "").trim()) continue;
    out.push(l + "{/em}".repeat(open));
  }
  return out;
}
