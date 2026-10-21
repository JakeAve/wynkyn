// web/src/editor-insert.ts — inserting sentinels from inside the editor
// (spec §7.3): `{` completions, a wrap bar over a selection, and a ⌘K list
// of every sentinel. All insertion goes through applySnippet.
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  ChangeSet,
  type EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type TransactionSpec,
} from "@codemirror/state";
import {
  type EditorView,
  keymap,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import {
  applySnippet,
  closingForm,
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
const MOD = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";

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
  view.dispatch({
    changes,
    selection: state.selection,
    effects: setStop.of(nextField(used, state.selection.main.from)),
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

function formCell(c: Completion): Node {
  const f = document.createElement("span");
  f.className = "f";
  const s = SNIPPETS.find((s) => s.label === c.label);
  f.textContent = s ? closingForm(s) : "";
  return f;
}

// ---- ⌘K: every sentinel, filtered by name or description ----

const setPalette = StateEffect.define<boolean>();
const paletteField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setPalette)) {
        return e.value ? tr.state.selection.main.from : null;
      }
    }
    return tr.docChanged || tr.selection ? null : v;
  },
  provide: (f) =>
    showTooltip.from(
      f,
      (pos): Tooltip | null =>
        pos === null ? null : { pos, create: paletteView },
    ),
});

function openPalette(view: EditorView): boolean {
  view.dispatch({ effects: setPalette.of(true) });
  return true;
}

function row(s: Snippet): HTMLLIElement {
  const li = document.createElement("li");
  const name = document.createElement("code");
  name.textContent = s.label;
  const d = document.createElement("span");
  d.className = "d";
  d.textContent = s.description;
  const f = document.createElement("span");
  f.className = "f";
  f.textContent = closingForm(s);
  li.append(name, d, f);
  return li;
}

function paletteView(view: EditorView) {
  const dom = document.createElement("div");
  dom.className = "cm-bml-palette";
  const input = document.createElement("input");
  input.placeholder = "Insert a sentinel…";
  input.setAttribute("aria-label", "Find a sentinel");
  input.spellcheck = false;
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  dom.append(input, list);

  let shown: Snippet[] = [];
  let on = 0;
  const close = () => {
    view.dispatch({ effects: setPalette.of(false) });
    view.focus();
  };
  const pick = (s: Snippet | undefined) => s && insertSnippet(view, s); // the edit closes the list
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = SNIPPETS.filter((s) =>
      s.label.includes(q) || s.description.toLowerCase().includes(q)
    ).sort((a, b) => RANK[a.group] - RANK[b.group]);
    on = Math.min(on, Math.max(shown.length - 1, 0));
    list.replaceChildren();
    let group: SnippetGroup | null = null;
    shown.forEach((s, i) => {
      if (s.group !== group) {
        group = s.group;
        const h = document.createElement("li");
        h.className = "grp";
        h.textContent = GROUPS[group];
        list.append(h);
      }
      const li = row(s);
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === on));
      li.onmousedown = (e) => e.preventDefault(); // keep the input focused
      li.onclick = () => pick(s);
      list.append(li);
      if (i === on) li.scrollIntoView({ block: "nearest" });
    });
  };
  input.oninput = () => {
    on = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      on = (on + (e.key === "ArrowDown" ? 1 : -1) + shown.length) %
        Math.max(shown.length, 1);
      render();
    } else if (e.key === "Enter") pick(shown[on]);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  };
  input.onblur = () => {
    if (view.state.field(paletteField, false) !== null) {
      view.dispatch({ effects: setPalette.of(false) });
    }
  };
  render();
  return { dom, mount: () => input.focus() };
}

// ---- wrap bar over a non-empty selection ----

function wrapBar(view: EditorView) {
  const dom = document.createElement("div");
  dom.className = "cm-bml-wrapbar";
  const button = (text: string, chord: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (chord) {
      const k = document.createElement("kbd");
      k.textContent = chord;
      b.append(k);
    }
    b.onmousedown = (e) => e.preventDefault(); // keep the selection
    b.onclick = run;
    return b;
  };
  const sep = document.createElement("span");
  sep.className = "vsep";
  dom.append(
    button("Emphasis", `${MOD}I`, () => insertSnippet(view, snippet("em"))),
    button("Quote", "", () => insertSnippet(view, snippet("quote"))),
    button("Footnote", "", () => insertSnippet(view, snippet("footnote"))),
    sep,
    button("Wrap in…", `${MOD}K`, () => openPalette(view)),
  );
  return { dom };
}

// Only a selection the writer made (mouse, Shift+arrows, select all) shows
// the bar, not a placeholder that an insertion selected.
const wrapBarField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) =>
    tr.isUserEvent("select") ? true : tr.docChanged || tr.selection ? false : v,
  provide: (f) =>
    showTooltip.compute([f, "selection", paletteField], (state) => {
      const { from, empty } = state.selection.main;
      if (!state.field(f) || empty || state.field(paletteField) !== null) {
        return null;
      }
      return { pos: from, above: true, create: wrapBar };
    }),
});

export function insertExtensions(): Extension[] {
  return [
    autocompletion({
      override: [completions],
      icons: false,
      addToOptions: [{ render: formCell, position: 90 }],
    }),
    stopField,
    paletteField,
    wrapBarField,
    Prec.high(keymap.of([
      { key: "Tab", run: jumpToStop },
      { key: "Mod-i", run: (v) => insertSnippet(v, snippet("em")) },
      { key: "Mod-k", run: openPalette },
    ])),
  ];
}
