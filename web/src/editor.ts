// web/src/editor.ts — the CodeMirror pane (spec §7.3).
import { basicSetup } from "codemirror";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutterLineClass,
  type GutterMarker,
  WidgetType,
} from "@codemirror/view";
import {
  Compartment,
  EditorState,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { bml, ClassMarker, emRanges, hiddenLines } from "./bml-language.ts";
import { toCmDiagnostics } from "./diagnostics.ts";
import { searchPanel } from "./search-panel.ts";
import { insertExtensions } from "./editor-insert.ts";
import { spellExtensions } from "./spelling.ts";
import { imageExtensions, type ImageHost } from "./editor-images.ts";
import type { Diagnostic, OnlySpan } from "../../parser/types.ts";

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
  ".cm-activeLine": { backgroundColor: "var(--active)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--active)",
    color: "var(--fg)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--sel)" },
  ".cm-panels, .cm-tooltip": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
  },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line)" },
});

// ---- EXPERIMENTAL {only} spans: amber gutter line on every span, the
// opening line tagged with its editions, lines this edition skips dimmed ----

const setSpans = StateEffect.define<{ spans: OnlySpan[]; token: string }>();

class EditionsTag extends WidgetType {
  constructor(readonly editions: string) {
    super();
  }
  override eq(o: EditionsTag): boolean {
    return o.editions === this.editions;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-bml-cond-tag";
    s.textContent = this.editions;
    s.title = "Experimental: shown only in these editions";
    return s;
  }
}

interface SpanDecos {
  lines: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}

const condLine = Decoration.line({ class: "cm-bml-cond" });
const offLine = Decoration.line({ class: "cm-bml-off" });
const condGutter = new ClassMarker("cm-bml-cond");

function buildSpans(doc: Text, spans: OnlySpan[], token: string): SpanDecos {
  const decos: Range<Decoration>[] = [];
  const marks: Range<GutterMarker>[] = [];
  for (const s of spans) {
    if (s.line > doc.lines) continue;
    const off = !s.editions.includes(token);
    for (let n = s.line; n <= Math.min(s.endLine, doc.lines); n++) {
      const from = doc.line(n).from;
      decos.push(condLine.range(from));
      if (off) decos.push(offLine.range(from));
      marks.push(condGutter.range(from));
    }
    decos.push(
      Decoration.widget({
        widget: new EditionsTag(s.editions.join(" · ")),
        side: 1,
      }).range(doc.line(s.line).to),
    );
  }
  return {
    lines: Decoration.set(decos, true),
    gutter: RangeSet.of(marks, true),
  };
}

const editionSpans = StateField.define<SpanDecos>({
  create: () => ({ lines: Decoration.none, gutter: RangeSet.empty }),
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpans)) {
        return buildSpans(tr.state.doc, e.value.spans, e.value.token);
      }
    }
    return tr.docChanged
      ? { lines: v.lines.map(tr.changes), gutter: v.gutter.map(tr.changes) }
      : v;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.lines),
    gutterLineClass.from(f, (v) => v.gutter),
  ],
});

// Mark the {only} spans; `token` is the open edition's {only} token.
export function setEditionSpans(
  view: EditorView,
  spans: OnlySpan[],
  token: string,
): void {
  view.dispatch({ effects: setSpans.of({ spans, token }) });
}

// ---- hide markup (the text view bar): sentinel lines beside prose and {em} tags
// fold away everywhere but the cursor's paragraph (hiddenLines) ----

const hide = Decoration.replace({});

function buildHidden(state: EditorState): DecorationSet {
  const doc = state.doc;
  const lines = doc.toString().split("\n");
  const cursor = doc.lineAt(state.selection.main.head).number - 1;
  const decos: Range<Decoration>[] = [];
  for (const i of hiddenLines(lines, cursor)) {
    const l = doc.line(i + 1);
    // Fold the line into the one above, so the text line below keeps its
    // own decorations (bold after {title}); the first line folds forward.
    if (i > 0) decos.push(hide.range(l.from - 1, l.to));
    else if (doc.lines > 1) decos.push(hide.range(l.from, l.to + 1));
  }
  const [first, last] = paragraphOf(lines, cursor);
  let pos = 0;
  lines.forEach((line, i) => {
    if (i < first || i > last) {
      for (const [a, b, c, d] of emRanges(line)) {
        decos.push(hide.range(pos + a, pos + b), hide.range(pos + c, pos + d));
      }
    }
    pos += line.length + 1;
  });
  return Decoration.set(decos, true);
}

// The cursor's paragraph as [first, last] line (0-based); [-1, -1] on a
// blank line, so nothing is revealed there.
function paragraphOf(lines: string[], i: number): [number, number] {
  if (!lines[i]?.trim()) return [-1, -1];
  let a = i, b = i;
  while (a > 0 && lines[a - 1]!.trim()) a--;
  while (b < lines.length - 1 && lines[b + 1]!.trim()) b++;
  return [a, b];
}

// ponytail: whole-document rescan on every edit and cursor move; scan only
// when the cursor's paragraph changes if it lags on long books.
const hiddenMarkup = StateField.define<DecorationSet>({
  create: buildHidden,
  update: (v, tr) => tr.docChanged || tr.selection ? buildHidden(tr.state) : v,
  provide: (f) => EditorView.decorations.from(f),
});

const markup = new Compartment();

export function setHideMarkup(view: EditorView, on: boolean): void {
  view.dispatch({ effects: markup.reconfigure(on ? hiddenMarkup : []) });
}

export function createEditor(opts: {
  parent: HTMLElement;
  text: string;
  onDocChanged: (text: string) => void;
  onCursorLine?: (line: number) => void; // 1-based; fires when the cursor moves lines
  images?: ImageHost; // dropped or pasted image files go in the book
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
        searchPanel(),
        insertExtensions(),
        editionSpans,
        lintGutter(),
        markup.of([]),
        spellExtensions(),
        opts.images ? imageExtensions(opts.images) : [],
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
