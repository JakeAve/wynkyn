// web/src/snippets.ts — toolbar sentinel insertion (spec §7.3). Each snippet
// carries the correct open/close pair for its sentinel's closing form (§3.2.3):
// structural = no close, block = explicit {/...}, wrap = encloses selection,
// inline = point marker.
import type { EditorState, TransactionSpec } from "@codemirror/state";

export type SnippetKind = "block" | "inline" | "wrap";

export interface Snippet {
  label: string;
  kind: SnippetKind;
  text: string; // wrap: opening tag only; block/inline: full insertion
  closeText?: string; // wrap only
  placeholder?: string; // substring of text (or wrap fallback) selected after insert
}

export const SNIPPETS: Snippet[] = [
  {
    label: "matter",
    kind: "block",
    text: "{matter: preface}\n{title}\nPreface",
    placeholder: "preface",
  },
  {
    label: "part",
    kind: "block",
    text: "{part: slug}\n{title}\nPart Title",
    placeholder: "slug",
  },
  {
    label: "chapter",
    kind: "block",
    text: "{chapter: slug}\n{title}\nChapter Title",
    placeholder: "slug",
  },
  {
    label: "heading",
    kind: "block",
    text: "{heading}\nHeading",
    placeholder: "Heading",
  },
  {
    label: "subheading",
    kind: "block",
    text: "{subheading}\nSubheading",
    placeholder: "Subheading",
  },
  {
    label: "dropcap",
    kind: "block",
    text: "{dropcap}\nOpening paragraph",
    placeholder: "Opening paragraph",
  },
  { label: "break", kind: "block", text: "{break}" },
  {
    label: "epigraph",
    kind: "block",
    text: "{epigraph}\nQuotation\n{attribution}\n— Source",
    placeholder: "Quotation",
  },
  {
    label: "quote",
    kind: "block",
    text: "{quote}\nQuotation\n{/quote}",
    placeholder: "Quotation",
  },
  {
    label: "pullquote",
    kind: "block",
    text: "{pullquote}\nPulled phrase\n{/pullquote}",
    placeholder: "Pulled phrase",
  },
  {
    label: "sidebar",
    kind: "block",
    text: "{sidebar}\nAside text\n{/sidebar}",
    placeholder: "Aside text",
  },
  {
    label: "poem",
    kind: "block",
    text: "{poem}\nFirst line\\\nsecond line.\n{/poem}",
    placeholder: "First line",
  },
  {
    label: "verses",
    kind: "block",
    text: "{verses: slug}\nFirst verse.\n{/verses}",
    placeholder: "slug",
  },
  {
    label: "columns",
    kind: "block",
    text: "{columns: 2}\nColumn text\n{/columns}",
    placeholder: "Column text",
  },
  {
    label: "is",
    kind: "block",
    text: "{is: class-name}\nContent\n{/is: class-name}",
    placeholder: "class-name",
  },
  {
    label: "illustration",
    kind: "block",
    text: "{illustration: slug | placement: inline}\nCaption",
    placeholder: "slug",
  },
  {
    label: "em",
    kind: "wrap",
    text: "{em}",
    closeText: "{/em}",
    placeholder: "emphasized",
  },
  {
    label: "footnote",
    kind: "inline",
    text: "{footnote: slug}",
    placeholder: "slug",
  },
  { label: "ref", kind: "inline", text: "{ref: slug}", placeholder: "slug" },
];

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
