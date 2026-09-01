// web/src/editor.ts — the CodeMirror pane (spec §7.3).
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { bml } from "./bml-language.ts";
import { toCmDiagnostics } from "./diagnostics.ts";
import type { Diagnostic } from "../../parser/types.ts";

// True while replaceBuffer() applies a remote change: those edits must not
// re-enter the save path (spec §6 — a save never round-trips).
let suppressChanges = false;

// Chrome-matched editor theme: every color is a CSS variable from
// index.html's Ink palette, so light/dark switching needs no CodeMirror
// reconfigure — the vars flip and the editor follows.
const inkTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--hover)",
    color: "var(--fg)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--sel)" },
  ".cm-panels, .cm-tooltip": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
  },
});

export function createEditor(opts: {
  parent: HTMLElement;
  text: string;
  onDocChanged: (text: string) => void;
  onCursorLine?: (line: number) => void; // 1-based; fires when the cursor moves lines
}): EditorView {
  let lastLine = 0;
  return new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.text,
      extensions: [
        basicSetup,
        inkTheme,
        bml(),
        lintGutter(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !suppressChanges) {
            opts.onDocChanged(u.state.doc.toString());
          }
          if (u.selectionSet || u.docChanged) {
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            if (line !== lastLine) {
              lastLine = line;
              opts.onCursorLine?.(line);
            }
          }
        }),
      ],
    }),
  });
}

export function applyDiagnostics(view: EditorView, diags: Diagnostic[]): void {
  view.dispatch(
    setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diags)),
  );
}

// Replace the whole buffer from an external change, preserving the cursor
// position as far as the new text allows.
export function replaceBuffer(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return;
  const head = Math.min(view.state.selection.main.head, text.length);
  suppressChanges = true;
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: head },
    });
  } finally {
    suppressChanges = false;
  }
}

export function scrollEditorToLine(view: EditorView, line: number): void {
  const l = view.state.doc.line(
    Math.min(Math.max(line, 1), view.state.doc.lines),
  );
  view.dispatch({
    selection: { anchor: l.from },
    effects: EditorView.scrollIntoView(l.from, { y: "start" }),
  });
  view.focus();
}
