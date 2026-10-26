// web/src/prose.ts — the write pane's Prose view (design-language.md §8.1):
// draws prose-model.ts over the CodeMirror document. Rubrics sit in the left
// margin and notes behind a ☞ in the right, as widgets positioned against
// .cm-content's padding (app.css, `.cm-prose-*`), so they wrap with their line.
// The cursor's paragraph shows its markup in place; every other paragraph
// folds it. Page turns from the last layout sit in the right margin too
// (setPageTurns). Nothing changes in the document.
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { parseSentinelLine } from "../../parser/sentinel.ts";
import { wrapRanges } from "./bml-language.ts";
import { type ProseLine, proseLines } from "./prose-model.ts";
import type { ImageHost } from "./editor-images.ts";
import type { PageTurn } from "./preview.ts";

// A line's margin marks: its rubric (label, slug beneath), on a folded row
// the stand-in that takes the line's place (⁂), and on the right its page
// turn and notes.
class Marks extends WidgetType {
  constructor(readonly p: ProseLine, readonly turn?: number) {
    super();
  }
  override eq(o: Marks): boolean {
    const a = this.p, b = o.p;
    return this.turn === o.turn && a.fold === b.fold &&
      a.standIn === b.standIn &&
      a.note === b.note && a.rubric?.label === b.rubric?.label &&
      a.rubric?.slug === b.rubric?.slug;
  }
  toDOM(): HTMLElement {
    const { fold, rubric, standIn, note } = this.p;
    const el = document.createElement("span");
    el.className = "cm-prose-marks";
    // Labels are drawn by CSS from data attributes, so a line's text stays
    // the document's text.
    if (rubric) {
      const r = el.appendChild(document.createElement("span"));
      r.className = "cm-prose-rubric";
      r.dataset.label = rubric.label;
      if (rubric.slug) r.dataset.slug = r.title = rubric.slug;
    }
    if (fold && standIn === "break") el.append("⁂");
    if (this.turn === undefined && note === undefined) return el;
    const side = el.appendChild(document.createElement("span"));
    side.className = "cm-prose-side";
    if (this.turn !== undefined) {
      // A rule and the number at normal width; "p. 12" (data-long) once
      // the margins widen.
      const t = side.appendChild(document.createElement("span"));
      t.className = "cm-prose-turn";
      t.dataset.turn = String(this.turn);
      t.dataset.long = `p. ${this.turn}`;
      t.title = `Page ${this.turn} begins here`;
    }
    if (note !== undefined) {
      // Both forms: the ☞ alone at normal width, the note on hover; the
      // note written out (data-note) once the margins widen.
      const n = side.appendChild(document.createElement("span"));
      n.className = "cm-prose-note";
      n.dataset.note = n.title = note;
    }
    return el;
  }
  // A click on a mark goes to the editor, so it lands on the mark's line
  // and reveals that block.
  override ignoreEvent(): boolean {
    return false;
  }
}

const hide = Decoration.replace({});
const lineClass = (c: string) => Decoration.line({ class: c });
const LINES = {
  title: lineClass("cm-prose-title"),
  subtitle: lineClass("cm-prose-subtitle"),
  block: lineClass("cm-prose-block"),
  rule: lineClass("cm-prose-rule"),
  break: lineClass("cm-prose-break"),
  src: lineClass("cm-prose-src"),
  slugged: lineClass("cm-prose-slugged"),
};

// The cursor's paragraph as 1-based [first, last] lines; [0, 0] on a blank
// line, where nothing is revealed.
function paragraphAt(doc: Text, pos: number): [number, number] {
  const n = doc.lineAt(pos).number;
  const full = (i: number) => doc.line(i).text.trim() !== "";
  if (!full(n)) return [0, 0];
  let a = n, b = n;
  while (a > 1 && full(a - 1)) a--;
  while (b < doc.lines && full(b + 1)) b++;
  return [a, b];
}

// Page turns as document positions (line starts) mapped to page numbers.
// An edit drops the turns in the paragraphs it touches: that block's page
// is unknown until the next layout lands and replaces them all. Kept in both
// views (editor.ts), so they survive a trip through Source.
const turnsEffect = StateEffect.define<PageTurn[] | null>();
export const turnsField = StateField.define<Map<number, number>>({
  create: () => new Map(),
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(turnsEffect)) continue;
      const doc = tr.state.doc;
      v = new Map(
        (e.value ?? []).filter((t) => t.line <= doc.lines)
          .map((t) => [doc.line(t.line).from, t.page]),
      );
    }
    if (!tr.docChanged || !v.size) return v;
    const old = tr.startState.doc;
    const touched: [number, number][] = [];
    tr.changes.iterChangedRanges((a, b) => {
      const [p0] = paragraphAt(old, a), [, p1] = paragraphAt(old, b);
      const from = old.line(p0 || old.lineAt(a).number).from;
      const to = old.line(p1 || old.lineAt(b).number).to;
      touched.push([from, to]);
    });
    const out = new Map<number, number>();
    for (const [pos, page] of v) {
      if (touched.some(([a, b]) => pos >= a && pos <= b)) continue;
      out.set(tr.changes.mapPos(pos), page);
    }
    return out;
  },
});

// The last layout's page turns (preview.ts pageTurns); null clears them.
export function setPageTurns(view: EditorView, turns: PageTurn[] | null): void {
  view.dispatch({ effects: turnsEffect.of(turns) });
}

interface Drawn {
  decos: DecorationSet;
  para: [number, number];
}

// ponytail: rescans the whole document on every edit and paragraph change;
// rescan only the changed blocks if long books lag.
function draw(state: EditorState): Drawn {
  const doc = state.doc;
  const lines = doc.toString().split("\n");
  const para = paragraphAt(doc, state.selection.main.head);
  const model = proseLines(lines, para[0] - 1);
  const turns = state.field(turnsField, false);
  const decos: Range<Decoration>[] = [];
  let carried: number | undefined; // a turn on a line folded into the next
  model.forEach((p, i) => {
    const l = doc.line(i + 1);
    const turn = turns?.get(l.from) ?? carried;
    carried = undefined;
    const row = !!p.rubric || p.standIn === "break";
    if (p.fold && !row) {
      // Fold into the line above, so the text line below keeps its own
      // decorations; the first line folds forward.
      if (i > 0) decos.push(hide.range(l.from - 1, l.to));
      else if (doc.lines > 1) decos.push(hide.range(l.from, l.to + 1));
      carried = turn;
      return;
    }
    if (p.kind) decos.push(LINES[p.kind].range(l.from));
    if (p.rubric?.rule) decos.push(LINES.rule.range(l.from));
    if (p.fold) {
      if (p.standIn === "break") decos.push(LINES.break.range(l.from));
      if (p.rubric?.slug) decos.push(LINES.slugged.range(l.from));
      decos.push(
        Decoration.replace({ widget: new Marks(p, turn) }).range(l.from, l.to),
      );
      return;
    }
    const text = lines[i]!;
    if (text.startsWith("%%") || parseSentinelLine(text)) {
      decos.push(LINES.src.range(l.from));
    }
    if (p.rubric || p.note !== undefined || turn !== undefined) {
      decos.push(
        Decoration.widget({ widget: new Marks(p, turn), side: -1 }).range(
          l.from,
        ),
      );
    }
    if (i + 1 < para[0] || i + 1 > para[1]) {
      for (const w of wrapRanges(text)) {
        if (w.name !== "em") continue;
        const [a, b, c, d] = w.at;
        decos.push(hide.range(l.from + a, l.from + b));
        decos.push(hide.range(l.from + c, l.from + d));
      }
    }
  });
  return { decos: Decoration.set(decos, true), para };
}

const prosed = StateField.define<Drawn>({
  create: draw,
  update(v, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(turnsEffect))) {
      return draw(tr.state);
    }
    if (!tr.selection) return v;
    const [a, b] = paragraphAt(tr.state.doc, tr.state.selection.main.head);
    return a === v.para[0] && b === v.para[1] ? v : draw(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// `opts.images` is for drawing illustrations (planned, §8.1 Images).
export function prose(_opts?: { images?: ImageHost }): Extension {
  return prosed;
}
