// web/src/search-panel.ts — the find/replace bar pinned to the top of the
// editor: CodeMirror's search state and commands under Ink-styled DOM.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState, Extension } from "@codemirror/state";
import {
  type EditorView,
  type Panel,
  runScopeHandlers,
  type ViewUpdate,
} from "@codemirror/view";
import { structuralBlock } from "./bml-language.ts";

const COUNT_CAP = 999; // stop counting past this many hits

type Flag = "caseSensitive" | "wholeWord" | "regexp";

function withQuery(q: SearchQuery, over: Partial<SearchQuery>): SearchQuery {
  return new SearchQuery({
    search: q.search,
    replace: q.replace,
    caseSensitive: q.caseSensitive,
    wholeWord: q.wholeWord,
    regexp: q.regexp,
    test: q.test,
    ...over,
  });
}

type Hit = { from: number; to: number };

// Every hit, up to one past COUNT_CAP. Costs a pass over the document, so it
// reruns only when the query or the doc changes.
function findHits(state: EditorState, q: SearchQuery): Hit[] {
  if (!q.search || !q.valid) return [];
  const hits: Hit[] = [];
  const cursor = q.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    hits.push({ from: r.value.from, to: r.value.to });
    if (hits.length > COUNT_CAP) break;
  }
  return hits;
}

// "n of m": n is the hit the selection sits on, "–" when it is on none.
function countLabel(q: SearchQuery, hits: Hit[], sel: Hit): string {
  if (!q.search) return "";
  if (!q.valid) return "Invalid";
  if (!hits.length) return "No results";
  const cur = hits.findIndex((h) => h.from === sel.from && h.to === sel.to);
  const n = hits.length > COUNT_CAP ? `${COUNT_CAP}+` : hits.length;
  return `${cur < 0 || cur >= COUNT_CAP ? "–" : cur + 1} of ${n}`;
}

function button(
  text: string,
  title: string,
  className: string,
  onclick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onclick;
  return b;
}

function createPanel(view: EditorView): Panel {
  let query = getSearchQuery(view.state);
  let inChapter = false;

  const input = (label: string, placeholder: string) => {
    const i = document.createElement("input");
    i.setAttribute("aria-label", label);
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.oninput = commit;
    return i;
  };
  const field = (...kids: HTMLElement[]) => {
    const d = document.createElement("div");
    d.className = "field";
    d.append(...kids);
    return d;
  };
  const acts = (...kids: HTMLElement[]) => {
    const d = document.createElement("div");
    d.className = "acts";
    d.append(...kids);
    return d;
  };

  const find = input("Find", "Find");
  find.setAttribute("main-field", "true"); // CodeMirror focuses this on open
  const repl = input("Replace", "Replace with");
  const flag = (f: Flag, text: string, title: string) =>
    button(text, title, "opt", () => {
      view.dispatch({
        effects: setSearchQuery.of(withQuery(query, { [f]: !query[f] })),
      });
    });
  const flags: [Flag, HTMLButtonElement][] = [
    ["caseSensitive", flag("caseSensitive", "Aa", "Match case")],
    ["wholeWord", flag("wholeWord", "ab", "Whole word")],
    ["regexp", flag("regexp", ".*", "Regular expression")],
  ];
  const count = document.createElement("span");
  count.className = "count";
  count.setAttribute("aria-live", "polite");
  const scope = button(
    "in chapter",
    "Replace All only in this chapter",
    "opt",
    () => {
      inChapter = !inChapter;
      scope.setAttribute("aria-pressed", String(inChapter));
    },
  );
  scope.setAttribute("aria-pressed", "false");

  function commit(): void {
    const q = withQuery(query, { search: find.value, replace: repl.value });
    if (!q.eq(query)) view.dispatch({ effects: setSearchQuery.of(q) });
  }

  let hits: Hit[] = [];
  function sync(recount: boolean): void {
    if (recount) hits = findHits(view.state, query);
    if (find.value !== query.search) find.value = query.search;
    if (repl.value !== query.replace) repl.value = query.replace;
    for (const [f, b] of flags) {
      b.setAttribute("aria-pressed", String(query[f]));
    }
    count.textContent = countLabel(query, hits, view.state.selection.main);
  }

  // "in chapter": Replace All under a query whose test admits only hits in
  // the structural block at the cursor, then the plain query again.
  function all(): void {
    if (!inChapter) {
      replaceAll(view);
      return;
    }
    const { doc, selection } = view.state;
    const [a, b] = structuralBlock(
      (n) => doc.line(n).text,
      doc.lines,
      doc.lineAt(selection.main.head).number,
    );
    const lo = doc.line(a).from, hi = doc.line(b).to;
    const plain = query;
    view.dispatch({
      effects: setSearchQuery.of(
        withQuery(plain, {
          test: (_m, _s, from, to) => from >= lo && to <= hi,
        }),
      ),
    });
    replaceAll(view);
    view.dispatch({ effects: setSearchQuery.of(plain) });
  }

  const dom = document.createElement("div");
  dom.className = "cm-bml-find";
  dom.append(
    field(find, ...flags.map(([, b]) => b)),
    acts(
      count,
      button("↑", "Previous (Shift+Enter)", "ghost", () => findPrevious(view)),
      button("↓", "Next (Enter)", "ghost", () => findNext(view)),
      button("×", "Close (Esc)", "ghost", () => closeSearchPanel(view)),
    ),
    field(repl),
    acts(
      button(
        "Replace",
        "Replace (Enter in Replace)",
        "btn",
        () => replaceNext(view),
      ),
      button("All", "Replace all", "btn", all),
      scope,
    ),
  );
  dom.onkeydown = (e) => {
    if (runScopeHandlers(view, e, "search-panel")) e.preventDefault();
    else if (e.key === "Enter" && e.target === find) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === "Enter" && e.target === repl) {
      e.preventDefault();
      replaceNext(view);
    }
  };
  sync(true);

  return {
    dom,
    top: true,
    mount: () => find.select(),
    update(u: ViewUpdate) {
      let recount = u.docChanged;
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (e.is(setSearchQuery)) {
            query = e.value;
            recount = true;
          }
        }
      }
      if (recount || u.selectionSet) sync(recount);
    },
  };
}

export function searchPanel(): Extension {
  return search({ top: true, createPanel });
}
