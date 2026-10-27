// web/src/prose.ts — the write pane's Prose view (design-language.md §8.1):
// draws prose-model.ts over the CodeMirror document. Rubrics sit in the left
// margin and notes behind a ☞ in the right, as widgets positioned against
// .cm-content's padding (app.css, `.cm-prose-*`), so they wrap with their line.
// The cursor's paragraph shows its markup in place; every other paragraph
// folds it. Page turns from the last layout sit in the right margin too
// (setPageTurns). An illustration whose file exists draws its image as a
// block above its line, its rubric beside it. Nothing changes in the document.
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
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
import { IMAGE_EXTS, type ImageFile } from "../../server/images.ts";
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

// An illustration's image, a block above its line, with the line's marks
// beside it. A click puts the cursor on its line, which reveals the markup.
class Picture extends WidgetType {
  constructor(readonly url: string, readonly marks: Marks) {
    super();
  }
  override eq(o: Picture): boolean {
    return this.url === o.url && this.marks.eq(o.marks);
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-prose-illustration";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = "";
    el.append(this.marks.toDOM(), img);
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

// The book's images by slug (an image URL each), as the app last listed
// them; null until listed, when no illustration counts as missing.
const imagesEffect = StateEffect.define<Map<string, string>>();
const imagesField = StateField.define<Map<string, string> | null>({
  create: () => null,
  update: (v, tr) =>
    tr.effects.reduce((m, e) => e.is(imagesEffect) ? e.value : m, v),
});

// Lists the book's images now and after each edit: host.images() fetches
// at most every few seconds and again after an add (a drop, a paste, a
// pick), as the completions do. A list that maps the same slugs to the same
// URLs changes nothing, so it doesn't redraw.
function imageLister(host: ImageHost) {
  return ViewPlugin.define((view) => {
    let last: ImageFile[] | null = null;
    let destroyed = false;
    const list = () =>
      host.images().then(async (files) => {
        if (files === last) return;
        last = files;
        const rank = (f: ImageFile) =>
          IMAGE_EXTS.indexOf(f.name.slice(f.slug.length + 1).toLowerCase());
        // the resolver's order when two files share a slug (spec §4.11)
        const names = new Map<string, string>();
        for (const f of [...files].sort((a, b) => rank(a) - rank(b))) {
          if (!names.has(f.slug)) names.set(f.slug, f.name);
        }
        const urls = await Promise.all(
          [...names.values()].map((n) => host.url(n)),
        );
        const map = new Map([...names.keys()].map((s, i) => [s, urls[i]!]));
        const had = view.state.field(imagesField, false);
        const same = had?.size === map.size &&
          [...map].every(([s, u]) => had.get(s) === u);
        if (!destroyed && !same) {
          view.dispatch({ effects: imagesEffect.of(map) });
        }
      }, () => {});
    list();
    return {
      update(u) {
        if (u.docChanged) list();
      },
      destroy() {
        destroyed = true;
      },
    };
  });
}

const hide = Decoration.replace({});
const lineClass = (c: string) => Decoration.line({ class: c });
const LINES = {
  title: lineClass("cm-prose-title"),
  subtitle: lineClass("cm-prose-subtitle"),
  block: lineClass("cm-prose-block"),
  rule: lineClass("cm-prose-rule"),
  break: lineClass("cm-prose-break"),
  caption: lineClass("cm-prose-caption"),
  src: lineClass("cm-prose-src"),
  slugged: lineClass("cm-prose-slugged"),
};

// The cursor's paragraph as 1-based [first, last] lines; [0, 0] on a blank
// line, where nothing is revealed. Dim (editor.ts) keeps the same paragraph.
export function paragraphAt(doc: Text, pos: number): [number, number] {
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
  held: boolean; // a mouse button is down: the reveal waits for its release
}

// ponytail: rescans the whole document on every edit and paragraph change;
// rescan only the changed blocks if long books lag.
function draw(
  state: EditorState,
  para: [number, number],
  held: boolean,
): Drawn {
  const doc = state.doc;
  const lines = doc.toString().split("\n");
  const images = state.field(imagesField, false) ?? null;
  const model = proseLines(
    lines,
    para[0] - 1,
    images ? (slug) => images.has(slug) : undefined,
  );
  const turns = state.field(turnsField, false);
  const decos: Range<Decoration>[] = [];
  let carried: number | undefined; // a turn on a line folded into the next
  let taken = -1; // a caption's line whose turn went beside its image
  let skip = -1; // the last line an illustration's fold took in
  model.forEach((p, i) => {
    if (i <= skip) return;
    const l = doc.line(i + 1);
    const turn = l.from === taken ? carried : turns?.get(l.from) ?? carried;
    carried = undefined;
    const url = p.standIn === "illustration" && images?.get(p.slug ?? "");
    if (url) {
      // The image above the line; folded, the line goes into the caption:
      // the next shown line, past folded notes and sentinels, whose row
      // starts here then (at the document's end an empty row stays). A turn
      // on the caption goes beside the image, since the fold covers it.
      let c = i + 1;
      const collapses = (k: number) =>
        model[k]?.fold && !model[k]!.rubric && !model[k]!.standIn;
      while (p.fold && collapses(c)) c++;
      const cap = p.fold && c < doc.lines ? doc.line(c + 1).from : -1;
      let capTurn = cap < 0 ? undefined : turns?.get(cap);
      for (let k = i + 1; k < c && capTurn === undefined; k++) {
        capTurn = turns?.get(doc.line(k + 1).from);
      }
      if (cap >= 0) taken = cap;
      decos.push(
        Decoration.widget({
          widget: new Picture(url, new Marks(p, turn ?? capTurn)),
          block: true,
          side: -1,
        }).range(l.from),
      );
      if (!p.fold) decos.push(LINES.src.range(l.from));
      else {
        // The caption's row starts here now, so its class goes here too.
        decos.push(hide.range(l.from, cap < 0 ? doc.line(c).to : cap));
        const kind = model[c]?.kind;
        if (cap >= 0 && kind) decos.push(LINES[kind].range(l.from));
        skip = c - 1;
      }
      return;
    }
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
  return { decos: Decoration.set(decos, true), para, held };
}

// A click on a folded paragraph reveals its markup, which moves the text
// under the pointer; were that at mousedown, a pixel of drift before mouseup
// would select across the shift. So the reveal waits for the release, after
// CodeMirror's own mouseup (a click inside a selection selects then).
const heldEffect = StateEffect.define<boolean>();
const holdReveal = ViewPlugin.define(() => ({}), {
  eventHandlers: {
    mousedown(e, view) {
      if (e.button !== 0) return;
      view.dispatch({ effects: heldEffect.of(true) });
      // On the window, so it runs after CodeMirror's listener on the document.
      view.dom.ownerDocument.defaultView?.addEventListener(
        "mouseup",
        () => view.dispatch({ effects: heldEffect.of(false) }),
        { once: true },
      );
    },
  },
});

const prosed = StateField.define<Drawn>({
  create: (state) =>
    draw(state, paragraphAt(state.doc, state.selection.main.head), false),
  update(v, tr) {
    let held = v.held;
    for (const e of tr.effects) if (e.is(heldEffect)) held = e.value;
    // Only the pointer holds: a key that moves the cursor reveals at once.
    if (tr.selection && !tr.isUserEvent("select.pointer")) held = false;
    const para = held && !tr.docChanged
      ? v.para
      : paragraphAt(tr.state.doc, tr.state.selection.main.head);
    if (
      tr.docChanged || para[0] !== v.para[0] || para[1] !== v.para[1] ||
      tr.effects.some((e) => e.is(turnsEffect) || e.is(imagesEffect))
    ) {
      return draw(tr.state, para, held);
    }
    return held === v.held ? v : { ...v, held };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// `opts.images`: the book's images, for drawing illustrations. Without it
// an illustration is its rubric alone.
export function prose(opts?: { images?: ImageHost }): Extension {
  return opts?.images
    ? [imagesField, prosed, holdReveal, imageLister(opts.images)]
    : [prosed, holdReveal];
}
