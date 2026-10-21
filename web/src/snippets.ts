// web/src/snippets.ts — sentinel insertion from the editor (spec §7.3). Each snippet
// carries the correct open/close pair for its sentinel's closing form (§3.2.3):
// structural = no close, block = explicit {/...}, wrap = encloses selection,
// inline = point marker.
import type { EditorState, TransactionSpec } from "@codemirror/state";

export type SnippetKind = "block" | "inline" | "wrap";
export type SnippetGroup = "structure" | "block" | "inline";

export interface Snippet {
  label: string;
  kind: SnippetKind;
  group: SnippetGroup;
  description: string;
  text: string; // wrap: opening tag only; block/inline: full insertion
  closeText?: string; // wrap only
  placeholder?: string; // substring of text (or wrap fallback) selected after insert
}

export const SNIPPETS: Snippet[] = [
  {
    label: "matter",
    group: "structure",
    description: "Front or back matter, by type",
    kind: "block",
    text: "{matter: preface}\n{title}\nPreface",
    placeholder: "preface",
  },
  {
    label: "part",
    group: "structure",
    description: "Part, grouping chapters",
    kind: "block",
    text: "{part: slug}\n{title}\nPart Title",
    placeholder: "slug",
  },
  {
    label: "chapter",
    group: "structure",
    description: "Chapter, with a slug and title",
    kind: "block",
    text: "{chapter: slug}\n{title}\nChapter Title",
    placeholder: "slug",
  },
  {
    label: "heading",
    group: "structure",
    description: "Section heading",
    kind: "block",
    text: "{heading}\nHeading",
    placeholder: "Heading",
  },
  {
    label: "subheading",
    group: "structure",
    description: "Minor heading",
    kind: "block",
    text: "{subheading}\nSubheading",
    placeholder: "Subheading",
  },
  {
    label: "dropcap",
    group: "block",
    description: "Paragraph opening with a drop cap",
    kind: "block",
    text: "{dropcap}\nOpening paragraph",
    placeholder: "Opening paragraph",
  },
  {
    label: "break",
    group: "block",
    description: "Scene break",
    kind: "block",
    text: "{break}",
  },
  {
    label: "epigraph",
    group: "block",
    description: "Quotation before a chapter",
    kind: "block",
    text: "{epigraph}\nQuotation\n{attribution}\n— Source",
    placeholder: "Quotation",
  },
  {
    label: "quote",
    group: "block",
    description: "Block quotation",
    kind: "block",
    text: "{quote}\nQuotation\n{/quote}",
    placeholder: "Quotation",
  },
  {
    label: "pullquote",
    group: "block",
    description: "Phrase pulled out large",
    kind: "block",
    text: "{pullquote}\nPulled phrase\n{/pullquote}",
    placeholder: "Pulled phrase",
  },
  {
    label: "sidebar",
    group: "block",
    description: "Boxed aside",
    kind: "block",
    text: "{sidebar}\nAside text\n{/sidebar}",
    placeholder: "Aside text",
  },
  {
    label: "poem",
    group: "block",
    description: "Stanzas, no numbering",
    kind: "block",
    text: "{poem}\nFirst line\\\nsecond line.\n{/poem}",
    placeholder: "First line",
  },
  {
    label: "verses",
    group: "block",
    description: "Numbered verses",
    kind: "block",
    text: "{verses: slug}\nFirst verse.\n{/verses}",
    placeholder: "slug",
  },
  {
    label: "columns",
    group: "block",
    description: "Text set in columns",
    kind: "block",
    text: "{columns: 2}\nColumn text\n{/columns}",
    placeholder: "Column text",
  },
  {
    label: "is",
    group: "block",
    description: "Block styled by a class name",
    kind: "block",
    text: "{is: class-name}\nContent\n{/is: class-name}",
    placeholder: "class-name",
  },
  {
    label: "illustration",
    group: "block",
    description: "Image with a caption",
    kind: "block",
    text: "{illustration: slug | placement: inline}\nCaption",
    placeholder: "slug",
  },
  {
    label: "only",
    group: "block",
    description: "Only in some editions (experimental)",
    kind: "block",
    text: "{only: default}\nEdition text\n{/only}",
    placeholder: "default",
  },
  {
    label: "em",
    group: "inline",
    description: "Emphasis",
    kind: "wrap",
    text: "{em}",
    closeText: "{/em}",
    placeholder: "emphasized",
  },
  {
    label: "footnote",
    group: "inline",
    description: "Note anchor, with a slug",
    kind: "inline",
    text: "{footnote: slug}",
    placeholder: "slug",
  },
  {
    label: "ref",
    group: "inline",
    description: "Cross-reference to a slug",
    kind: "inline",
    text: "{ref: slug}",
    placeholder: "slug",
  },
];

// How a snippet closes, as the insert lists show it (§3.2.3).
export function closingForm(s: Snippet): string {
  if (s.kind === "wrap") return "wraps";
  if (s.kind === "inline") return "point";
  const close = s.text.match(/\{\/[a-z-]+/);
  return close ? `${close[0]}}` : "—";
}

// A block snippet with an explicit close, rebuilt around `selected` in place
// of its sample content; null when the snippet cannot enclose text.
export function wrapSnippet(s: Snippet, selected: string): Snippet | null {
  if (s.kind !== "block") return null;
  const lines = s.text.split("\n");
  const open = lines[0]!, close = lines[lines.length - 1]!;
  if (lines.length < 3 || !close.startsWith("{/")) return null;
  // Keep a slug placeholder on the opening line; otherwise leave the cursor
  // after the block (the selected text may also occur inside the tags).
  const placeholder = s.placeholder && open.includes(s.placeholder)
    ? s.placeholder
    : undefined;
  return { ...s, text: `${open}\n${selected}\n${close}`, placeholder };
}

// The Tab stop after a slug placeholder: the first plain line below the
// sentinel line holding the placeholder (a chapter's title, a block's text).
// `at` is where the placeholder starts in the document after applySnippet.
export function nextField(
  s: Snippet,
  at: number,
): { from: number; to: number } | null {
  const idx = s.placeholder ? s.text.indexOf(s.placeholder) : -1;
  if (s.kind === "wrap" || idx < 0) return null;
  let off = 0, past = false;
  for (const line of s.text.split("\n")) {
    if (past && !line.startsWith("{")) {
      return { from: at - idx + off, to: at - idx + off + line.length };
    }
    if (!past && idx <= off + line.length) {
      if (!line.startsWith("{")) return null;
      past = true;
    }
    off += line.length + 1;
  }
  return null;
}

export function applySnippet(
  state: EditorState,
  snippet: Snippet,
): TransactionSpec {
  const { from, to } = state.selection.main;

  if (snippet.kind === "wrap") {
    const selected = state.sliceDoc(from, to) || (snippet.placeholder ?? "");
    const insert = snippet.text + selected + (snippet.closeText ?? "");
    const selFrom = from + snippet.text.length;
    return {
      changes: { from, to, insert },
      selection: { anchor: selFrom, head: selFrom + selected.length },
    };
  }

  if (snippet.kind === "inline") {
    return withPlaceholderSelection(from, to, snippet, snippet.text, 0);
  }

  // block: exactly one blank line between the sentinel and surrounding text —
  // blank lines are structurally meaningful in BML (§3.2.5).
  const before = state.sliceDoc(Math.max(0, from - 2), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + 2));
  const prefix = from === 0 || before.endsWith("\n\n")
    ? ""
    : before.endsWith("\n")
    ? "\n"
    : "\n\n";
  const suffix = to === state.doc.length || after.startsWith("\n\n")
    ? ""
    : after.startsWith("\n")
    ? "\n"
    : "\n\n";
  return withPlaceholderSelection(
    from,
    to,
    snippet,
    prefix + snippet.text + suffix,
    prefix.length,
  );
}

function withPlaceholderSelection(
  from: number,
  to: number,
  snippet: Snippet,
  insert: string,
  textOffset: number,
): TransactionSpec {
  const idx = snippet.placeholder
    ? snippet.text.indexOf(snippet.placeholder)
    : -1;
  const selection = snippet.placeholder && idx >= 0
    ? {
      anchor: from + textOffset + idx,
      head: from + textOffset + idx + snippet.placeholder.length,
    }
    : { anchor: from + insert.length };
  return { changes: { from, to, insert }, selection };
}
