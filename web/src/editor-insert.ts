// web/src/editor-insert.ts — inserting sentinels from inside the editor
// (spec §7.3): `{` completions and a wrap bar over a selection. All insertion
// goes through applySnippet.
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type TransactionSpec,
} from "@codemirror/state";
import { type EditorView, keymap, showTooltip } from "@codemirror/view";
import {
  applySnippet,
  closingForm,
  linkedClose,
  nextField,
  overSelection,
  type Snippet,
  type SnippetGroup,
  SNIPPETS,
} from "./snippets.ts";

const GROUPS: Record<SnippetGroup, string> = {
  structure: "Structure",
  block: "Blocks",
  inline: "In the paragraph",
};
const RANK: Record<SnippetGroup, number> = {
  structure: 0,
  block: 1,
  inline: 2,
};

function snippet(label: string): Snippet {
  return SNIPPETS.find((s) => s.label === label)!;
}

// ---- Tab stop: after a slug placeholder, Tab selects the title ----

type Range = { from: number; to: number };
const setStop = StateEffect.define<Range | null>();
const stopField = StateField.define<Range | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setStop)) return e.value;
    if (!v || (tr.selection && !tr.docChanged)) return null; // moved away
    return { from: tr.changes.mapPos(v.from, -1), to: tr.changes.mapPos(v.to) };
  },
});

function jumpToStop(view: EditorView): boolean {
  const stop = view.state.field(stopField);
  if (!stop) return false;
  view.dispatch({
    selection: { anchor: stop.from, head: stop.to },
    effects: setStop.of(null),
    scrollIntoView: true,
  });
  return true;
}

// Insert a snippet at the selection, first deleting `replace` (the typed
// `{quo`). A wrap snippet encloses the selection; the rest is overSelection's.
export function insertSnippet(
  view: EditorView,
  s: Snippet,
  replace?: Range,
): boolean {
  let state: EditorState = view.state;
  let changes = ChangeSet.empty(state.doc.length);
  const step = (spec: TransactionSpec) => {
    const tr = state.update(spec);
    changes = changes.compose(tr.changes);
    state = tr.state;
  };
  if (replace) {
    step({ changes: replace, selection: { anchor: replace.from } });
  }
  let used = s;
  const { from, to } = state.selection.main;
  if (from !== to && s.kind !== "wrap") {
    const over = overSelection(state, s);
    used = over.snippet;
    step({ selection: over.selection });
  }
  step(applySnippet(state, used));
  const { from: at, to: end } = state.selection.main;
  // `{is: name}`'s name is selected in the closing tag too, so typing it
  // renames both and one undo takes both back.
  const close = linkedClose(used, at);
  view.dispatch({
    changes,
    selection: close
      ? EditorSelection.create([
        EditorSelection.range(at, end),
        EditorSelection.range(close.from, close.to),
      ])
      : state.selection,
    effects: setStop.of(nextField(used, at)),
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
  return true;
}

// ---- `{` completions ----

function completions(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\{[\w-]*$/);
  if (!m) return null;
  return {
    from: m.from + 1,
    validFor: /^[\w-]*$/,
    options: SNIPPETS.map((s): Completion => ({
      label: s.label,
      detail: s.description,
      section: { name: GROUPS[s.group], rank: RANK[s.group] },
      apply: (view, _c, from, to) => {
        // closeBrackets may have typed the `}` already
        const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
        insertSnippet(view, s, { from: from - 1, to: end });
      },
    })),
  };
}

/** A completion that draws its own leading cell (an image's thumbnail). */
export type CellCompletion = Completion & { cell?: () => Node };

const leadCell = (c: CellCompletion): Node | null => c.cell?.() ?? null;

function formCell(c: Completion): Node {
  const f = document.createElement("span");
  f.className = "f";
  const s = SNIPPETS.find((s) => s.label === c.label);
  f.textContent = s ? closingForm(s) : "";
  return f;
}

// ---- wrap bar over a non-empty selection ----

function wrapBar(view: EditorView, wrapIn?: () => void) {
  const dom = document.createElement("div");
  dom.className = "cm-bml-wrapbar";
  // A kbd's key comes from the shortcuts' label pass (shortcuts.ts).
  const button = (text: string, command: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (command) {
      const k = document.createElement("kbd");
      k.dataset.command = command;
      b.append(k);
    }
    b.onmousedown = (e) => e.preventDefault(); // keep the selection
    b.onclick = run;
    return b;
  };
  const sep = document.createElement("span");
  sep.className = "vsep";
  dom.append(
    button("Emphasis", "em", () => insertSnippet(view, snippet("em"))),
    button("Quote", "", () => insertSnippet(view, snippet("quote"))),
    button("Footnote", "", () => insertSnippet(view, snippet("footnote"))),
    sep,
    ...(wrapIn ? [button("Wrap in…", "palette", wrapIn)] : []),
  );
  return { dom };
}

// Only a selection the writer made (mouse, Shift+arrows, select all) shows
// the bar, not a placeholder that an insertion selected.
const wrapBarField = (wrapIn?: () => void) =>
  StateField.define<boolean>({
    create: () => false,
    update: (v, tr) =>
      tr.isUserEvent("select")
        ? true
        : tr.docChanged || tr.selection
        ? false
        : v,
    provide: (f) =>
      showTooltip.compute([f, "selection"], (state) => {
        const { from, empty } = state.selection.main;
        if (!state.field(f) || empty) return null;
        return {
          pos: from,
          above: true,
          create: (view: EditorView) => wrapBar(view, wrapIn),
        };
      }),
  });

/** `extra` sources join the `{` completions in the one autocompletion. */
export function insertExtensions(
  extra: CompletionSource[] = [],
  wrapIn?: () => void,
): Extension[] {
  return [
    autocompletion({
      override: [completions, ...extra],
      icons: false,
      addToOptions: [
        { render: leadCell, position: 20 },
        { render: formCell, position: 90 },
      ],
    }),
    stopField,
    wrapBarField(wrapIn),
    // Mod+I is an app shortcut (shortcuts.ts), which runs first.
    Prec.high(keymap.of([{ key: "Tab", run: jumpToStop }])),
  ];
}
