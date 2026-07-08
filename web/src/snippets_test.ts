import { assertEquals } from "jsr:@std/assert";
import { EditorState } from "@codemirror/state";
import { applySnippet, SNIPPETS } from "./snippets.ts";

function stateWith(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: { anchor, head } });
}

function snippet(label: string) {
  return SNIPPETS.find((s) => s.label === label)!;
}

Deno.test("block snippet separates itself with blank lines and selects the placeholder", () => {
  const state = stateWith("Some prose.\nMore prose.", 11); // cursor at end of line 1
  const tr = state.update(applySnippet(state, snippet("chapter")));
  assertEquals(
    tr.state.doc.toString(),
    "Some prose.\n\n{chapter: slug}\n{title}\nChapter Title\n\nMore prose.",
  );
  const sel = tr.state.selection.main;
  assertEquals(tr.state.sliceDoc(sel.from, sel.to), "slug");
});

Deno.test("block snippet after an existing blank line adds no extra separation", () => {
  const state = stateWith("Some prose.\n\n", 13);
  const tr = state.update(applySnippet(state, snippet("break")));
  assertEquals(tr.state.doc.toString(), "Some prose.\n\n{break}");
});

Deno.test("wrap snippet wraps the selection", () => {
  const state = stateWith("the Queen Mary at dock", 4, 14);
  const tr = state.update(applySnippet(state, snippet("em")));
  assertEquals(tr.state.doc.toString(), "the {em}Queen Mary{/em} at dock");
  const sel = tr.state.selection.main;
  assertEquals(tr.state.sliceDoc(sel.from, sel.to), "Queen Mary");
});

Deno.test("wrap snippet with empty selection inserts a placeholder", () => {
  const state = stateWith("word ", 5);
  const tr = state.update(applySnippet(state, snippet("em")));
  assertEquals(tr.state.doc.toString(), "word {em}emphasized{/em}");
  const sel = tr.state.selection.main;
  assertEquals(tr.state.sliceDoc(sel.from, sel.to), "emphasized");
});

Deno.test("inline snippet inserts at the cursor and selects its slug", () => {
  const state = stateWith("was poor.", 9);
  const tr = state.update(applySnippet(state, snippet("footnote")));
  assertEquals(tr.state.doc.toString(), "was poor.{footnote: slug}");
  const sel = tr.state.selection.main;
  assertEquals(tr.state.sliceDoc(sel.from, sel.to), "slug");
});

Deno.test("every block snippet with an explicit close names the same sentinel", () => {
  // Guards against a typo like {quote}...{/qoute} in the table.
  for (const s of SNIPPETS.filter((s) => s.kind === "block" && s.text.includes("{/"))) {
    const open = s.text.match(/^\{([a-z-]+)/)![1];
    const close = s.text.match(/\{\/([a-z-]+)/)![1];
    assertEquals(close, open, `snippet ${s.label}`);
  }
});
