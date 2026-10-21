import { assertEquals } from "@std/assert";
import { EditorState } from "@codemirror/state";
import {
  applySnippet,
  closingForm,
  nextField,
  overSelection,
  SNIPPETS,
  wrapSnippet,
} from "./snippets.ts";

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
  for (
    const s of SNIPPETS.filter((s) =>
      s.kind === "block" && s.text.includes("{/")
    )
  ) {
    const open = s.text.match(/^\{([a-z-]+)/)![1];
    const close = s.text.match(/\{\/([a-z-]+)/)![1];
    assertEquals(close, open, `snippet ${s.label}`);
  }
});

Deno.test("closing forms read as the insert lists show them", () => {
  assertEquals(closingForm(snippet("quote")), "{/quote}");
  assertEquals(closingForm(snippet("is")), "{/is}");
  assertEquals(closingForm(snippet("em")), "wraps");
  assertEquals(closingForm(snippet("footnote")), "point");
  assertEquals(closingForm(snippet("chapter")), "—");
});

Deno.test("{only} is listed under blocks and marked experimental", () => {
  const only = snippet("only");
  assertEquals(only.group, "block");
  assertEquals(only.description.includes("experimental"), true);
});

Deno.test("wrapping a selection in a closed block keeps the text", () => {
  const state = stateWith("Before.\n\nThe text.\n\nAfter.", 9, 18);
  const tr = state.update(
    applySnippet(state, wrapSnippet(snippet("quote"), "The text.")!),
  );
  assertEquals(
    tr.state.doc.toString(),
    "Before.\n\n{quote}\nThe text.\n{/quote}\n\nAfter.",
  );
  assertEquals(wrapSnippet(snippet("epigraph"), "x"), null);
  assertEquals(wrapSnippet(snippet("em"), "x"), null);
});

Deno.test("Tab stop after a slug is the title line", () => {
  const state = stateWith("Prose.", 6);
  const tr = state.update(applySnippet(state, snippet("chapter")));
  const stop = nextField(snippet("chapter"), tr.state.selection.main.from)!;
  assertEquals(tr.state.sliceDoc(stop.from, stop.to), "Chapter Title");
  // a placeholder that is already the content has no further stop
  assertEquals(nextField(snippet("quote"), 0), null);
  assertEquals(nextField(snippet("footnote"), 0), null);
});

Deno.test("overSelection: a block without a close goes after the selected line, not mid-paragraph", () => {
  const state = stateWith("Para one here.\nNext.", 5, 8); // "one" selected
  const over = overSelection(state, snippet("chapter"));
  const at = state.update({ selection: over.selection }).state;
  assertEquals(
    at.update(applySnippet(at, over.snippet)).state.doc.toString(),
    "Para one here.\n\n{chapter: slug}\n{title}\nChapter Title\n\nNext.",
  );
});
