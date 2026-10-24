// web/src/spelling.ts — spell check in the editor (spec §7.3): prose words
// missing from the English word list (vendor/scowl/en.txt) and from the
// book's own dictionary.json get a wavy underline; hovering one offers
// suggestions and Add to dictionary.
import { Compartment, type Extension, Facet } from "@codemirror/state";
import {
  closeHoverTooltips,
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Which words count as spelled right, and how to add one to the book. */
export interface Speller {
  has(word: string): boolean;
  add(word: string): void;
}

/** A word list file: one word per line, after the licence header's `---`. */
export function parseWordList(text: string): Set<string> {
  const start = text.indexOf("\n---\n");
  return new Set(
    text.slice(start < 0 ? 0 : start + 5).split("\n").filter(Boolean),
  );
}

// A lowercase entry matches any capitalization ("The", "THE"); a capitalized
// one needs its capital ("Paris", "PARIS", never "paris"). A possessive is
// checked without its 's, so "Daisy" covers "Daisy's".
export function isKnown(word: string, has: (w: string) => boolean): boolean {
  const w = word.replaceAll("’", "'");
  if (has(w)) return true;
  const lower = w.toLowerCase();
  if (has(lower)) return true;
  if (w === w.toUpperCase() && has(lower[0]!.toUpperCase() + lower.slice(1))) {
    return true;
  }
  return /'s$/i.test(w) && w.length > 2 && isKnown(w.slice(0, -2), has);
}

// Markup is blanked out (same length, so offsets hold): `%%` comment lines,
// escapes, and every `{…}` tag, an unclosed one to the end of the line.
const MARKUP = /\\.|\{[^}]*\}?/g;
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;

/** The unknown words of one line, as [from, to) offsets into it. */
export function misspelled(
  line: string,
  has: (w: string) => boolean,
): [number, number][] {
  if (line.startsWith("%%")) return [];
  const prose = line.replace(MARKUP, (m) => " ".repeat(m.length));
  const out: [number, number][] = [];
  for (const m of prose.matchAll(WORD)) {
    const word = m[0].replace(/['’]+$/, "");
    if (word.length > 1 && !isKnown(word, has)) {
      out.push([m.index, m.index + word.length]);
    }
  }
  return out;
}

function edits(w: string): string[] {
  const letters = w === w.toUpperCase()
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ'"
    : "abcdefghijklmnopqrstuvwxyz'";
  const swaps: string[] = [], rest: string[] = [];
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b.length > 1) swaps.push(a + b[1] + b[0] + b.slice(2));
    if (b) rest.push(a + b.slice(1));
    for (const c of letters) {
      if (b) rest.push(a + c + b.slice(1));
      rest.push(a + c + b);
    }
  }
  return [...swaps, ...rest];
}

// ponytail: Norvig-style edits ranked by kind only (swapped letters, the
// commonest typo, then deletes, replacements, inserts), no word frequencies;
// a frequency list would rank "the" over "tie" for "teh".
/** Up to `max` known words one edit away, else two. */
export function suggest(
  word: string,
  has: (w: string) => boolean,
  max = 5,
): string[] {
  const out = new Set<string>();
  const ok = (c: string) => c.length > 1 && c !== word && isKnown(c, has);
  const near = edits(word);
  for (const c of near) if (ok(c)) out.add(c);
  for (const e of out.size ? [] : near) {
    for (const c of edits(e)) if (ok(c)) out.add(c);
    if (out.size >= max) break;
  }
  return [...out].slice(0, max);
}

// ---- the editor side ----

const speller = Facet.define<Speller | null, Speller | null>({
  combine: (v) => v[0] ?? null,
});

const mark = Decoration.mark({ class: "cm-bml-misspelled" });

// Only the visible lines are checked, so a long book costs nothing extra.
// The word being typed (the cursor at its end) waits until the cursor leaves.
function build(view: EditorView): DecorationSet {
  const sp = view.state.facet(speller);
  if (!sp) return Decoration.none;
  const { doc, selection } = view.state;
  const head = selection.main.empty ? selection.main.head : -1;
  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const line = doc.line(n);
      for (const [a, b] of misspelled(line.text, (w) => sp.has(w))) {
        if (line.from + b !== head) {
          marks.push(mark.range(line.from + a, line.from + b));
        }
      }
    }
  }
  return Decoration.set(marks);
}

const underline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged || u.viewportChanged || u.selectionSet ||
        u.startState.facet(speller) !== u.state.facet(speller)
      ) this.decorations = build(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

// Suggestions and Add to dictionary, in the wrap bar's look.
const menu = hoverTooltip((view, pos) => {
  const sp = view.state.facet(speller);
  if (!sp) return null;
  const line = view.state.doc.lineAt(pos);
  const hit = misspelled(line.text, (w) => sp.has(w)).find(([a, b]) =>
    line.from + a <= pos && pos <= line.from + b
  );
  if (!hit) return null;
  const [from, to] = [line.from + hit[0], line.from + hit[1]];
  const word = line.text.slice(hit[0], hit[1]);
  return {
    pos: from,
    end: to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-bml-wrapbar cm-bml-spell";
      const button = (text: string, title: string, run: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = title;
        b.onmousedown = (e) => e.preventDefault(); // keep the editor's focus
        b.onclick = () => {
          view.dispatch({ effects: closeHoverTooltips });
          run();
        };
        return b;
      };
      const fixes = suggest(word, (w) => sp.has(w));
      for (const s of fixes) {
        dom.append(button(s, `Replace with “${s}”`, () =>
          view.dispatch({
            changes: { from, to, insert: s },
            userEvent: "input.spell",
          })));
      }
      if (!fixes.length) {
        const none = document.createElement("span");
        none.className = "none";
        none.textContent = "No suggestions";
        dom.append(none);
      }
      const sep = document.createElement("span");
      sep.className = "vsep";
      // A possessive goes in as its name: "Daisy's" adds "Daisy".
      const entry = word.replace(/['’]s$/i, "");
      dom.append(
        sep,
        button(
          "Add to dictionary",
          `Spell “${entry}” right everywhere in this book (dictionary.json)`,
          () => sp.add(entry),
        ),
      );
      return { dom };
    },
  };
}, { hoverTime: 250 });

const spelling = new Compartment();

export function spellExtensions(): Extension {
  return spelling.of([]);
}

/** Turn spell check on with `sp`, or off with null. A new Speller (say, the
 * book's dictionary grew) redraws the underlines. */
export function setSpeller(view: EditorView, sp: Speller | null): void {
  view.dispatch({
    effects: spelling.reconfigure(sp ? [speller.of(sp), underline, menu] : []),
  });
}
