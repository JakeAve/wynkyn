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
  EditorState,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { bml, ClassMarker } from "./bml-language.ts";
import { toCmDiagnostics } from "./diagnostics.ts";
import { searchPanel } from "./search-panel.ts";
import { insertExtensions } from "./editor-insert.ts";
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

// ---- the style chip: on the cursor's line, a button to the style of what
// that line is part of (spec §7.3); app.ts resolves the key and the label ----

export interface StyleChip {
  line: number;
  label: string;
  open(): void;
}

const setChip = StateEffect.define<StyleChip | null>();

class ChipWidget extends WidgetType {
  constructor(readonly chip: StyleChip) {
    super();
  }
  override eq(o: ChipWidget): boolean {
    return o.chip.label === this.chip.label && o.chip.line === this.chip.line;
  }
  toDOM(): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-bml-style-chip";
    // The label is drawn by CSS from the attribute, so the editor's text
    // content stays the manuscript alone.
    b.dataset.label = this.chip.label;
    b.setAttribute("aria-label", `Open the style: ${this.chip.label}`);
    b.title = "Open this style";
    b.onclick = () => this.chip.open();
    return b;
  }
}

const styleChip = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setChip)) {
        const c = e.value;
        if (!c || c.line > tr.state.doc.lines) return Decoration.none;
        return Decoration.set(
          Decoration.widget({ widget: new ChipWidget(c), side: 1 }).range(
            tr.state.doc.line(c.line).to,
          ),
        );
      }
    }
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function setStyleChip(view: EditorView, chip: StyleChip | null): void {
  view.dispatch({ effects: setChip.of(chip) });
}

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
        searchPanel(),
        insertExtensions(),
        editionSpans,
        styleChip,
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
