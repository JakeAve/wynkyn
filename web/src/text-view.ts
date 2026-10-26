// web/src/text-view.ts — the write pane's header (design-language.md §8):
// Prose | Source, the Aa menu (face, size, dim, page turns) and Spelling (the
// word list plus the book's dictionary.json). A per-reader preference, kept in
// localStorage under `text-view`, never in the book.
import type { EditorView } from "@codemirror/view";
import type { Backend } from "./backend.ts";
import { type Dim, setDim, setWriteView, type WriteView } from "./editor.ts";
import { parseWordList, setSpeller } from "./spelling.ts";
import { $, brief } from "./dom.ts";

export interface TextViewDeps {
  editor: EditorView;
  backend: Backend;
  book: string;
  setStatus(kind: "error", detail: string): void;
  bodyFace(): string | null; // the CSS family of the book's body face, if known
}

export interface TextPrefs {
  view: WriteView;
  face: "alegreya" | "sans" | "book";
  size: number; // px at the default root, 12–24
  dim: Dim; // fade all but the cursor's paragraph or sentence
  turns: boolean; // page turns in the margin (prose.ts setPageTurns)
  spell: string; // a WORD_LISTS key or "none"
}

export interface TextView {
  toggleView(): void;
  prefs(): TextPrefs;
  refresh(): void; // the book's body face may have changed: after a layout
}

// Spell check (spec §7.3): the word list the Spelling menu picks, fetched
// once, and the book's dictionary.json, which Add to dictionary grows.
// Another language is one more list in vendor/ and one row here.
const WORD_LISTS: Record<string, { name: string; url: string }> = {
  en: { name: "English", url: "/vendor/words-en.txt" },
};
const wordLists = new Map<string, Promise<Set<string>>>();
async function spellCheck(
  d: TextViewDeps,
  lang: string,
  current: () => string,
): Promise<void> {
  const { editor, backend, book, setStatus } = d;
  const url = WORD_LISTS[lang]?.url;
  if (!url) return setSpeller(editor, null);
  try {
    let list = wordLists.get(lang);
    if (!list) {
      wordLists.set(
        lang,
        list = fetch(url).then((r) =>
          r.ok ? r.text() : Promise.reject(new Error(`word list: ${r.status}`))
        ).then(parseWordList),
      );
    }
    const [known, words] = await Promise.all([
      list,
      backend.dictionary(book),
    ]);
    const speller = (mine: Set<string>) => ({
      has: (w: string) => known.has(w) || mine.has(w),
      async add(w: string) {
        try {
          setSpeller(editor, speller(new Set(await backend.addWord(book, w))));
        } catch (err) {
          setStatus("error", `dictionary: ${brief(err)}`);
        }
      },
    });
    // Unless the menu moved on while the list loaded.
    if (current() === lang) setSpeller(editor, speller(new Set(words)));
  } catch (err) {
    wordLists.delete(lang); // try the fetch again next time
    setStatus("error", `spell check: ${brief(err)}`);
  }
}

const FACES = { alegreya: "var(--f-text)", sans: "var(--f-ui)" };
const DIMS: readonly Dim[] = ["off", "paragraph", "sentence"];
const DEFAULTS: TextPrefs = {
  view: "prose",
  face: "alegreya",
  size: 17,
  dim: "off",
  turns: true,
  spell: "en",
};

// What localStorage holds, checked key by key so a bad or old value falls back
// to its default. Before Prose and Source it was { font: serif|sans|mono,
// size, hide, spell }: mono is Source now, sans is Alegreya Sans, and hide is
// dropped (Prose folds markup).
export function readPrefs(raw: string | null): TextPrefs {
  const p = { ...DEFAULTS };
  let s: Record<string, unknown> = {};
  try {
    const v = JSON.parse(raw ?? "null");
    if (v && typeof v === "object") s = v;
  } catch {
    // not JSON: the defaults
  }
  if (s.font === "mono") p.view = "source";
  if (s.font === "sans") p.face = "sans";
  if (s.view === "prose" || s.view === "source") p.view = s.view;
  if (s.face === "alegreya" || s.face === "sans" || s.face === "book") {
    p.face = s.face;
  }
  // 16 was the old default, saved on every load: take the new one.
  if (typeof s.size === "number" && !("font" in s && s.size === 16)) {
    p.size = Math.min(24, Math.max(12, Math.round(s.size)));
  }
  const dim = DIMS.find((x) => x === s.dim);
  if (dim) p.dim = dim;
  if (typeof s.turns === "boolean") p.turns = s.turns;
  if (
    typeof s.spell === "string" && (s.spell in WORD_LISTS || s.spell === "none")
  ) p.spell = s.spell;
  return p;
}

// A §6.9 popover under its button: opens on a click, closes on another, on
// esc (app.ts POPUPS lets it go first) or on a mousedown outside.
function popover(btn: HTMLElement, pop: HTMLElement): () => void {
  const close = () => {
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", outside);
    document.removeEventListener("keydown", esc);
  };
  const outside = (e: MouseEvent) => {
    if (!btn.parentElement!.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (pop.contains(document.activeElement)) btn.focus();
    close();
  };
  btn.onclick = () => {
    if (!pop.hidden) return close();
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
  };
  return close;
}

export function installTextView(d: TextViewDeps): TextView {
  const { editor } = d;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("text-view");
  } catch {
    // storage blocked: the defaults
  }
  const prefs = readPrefs(raw);
  const ed = $("editor");
  const bar = $("text-view");
  const all = (sel: string) => [...bar.querySelectorAll<HTMLElement>(sel)];
  const check = (els: HTMLElement[], key: string, v: string) => {
    for (const b of els) {
      b.setAttribute("aria-checked", String(b.dataset[key] === v));
    }
  };
  const views = all("[data-view]");
  const faces = all("[data-face]");
  const dims = all("[data-dim]");
  const size = $("tv-size");
  const turns = $("tv-turns") as HTMLInputElement;
  const spellPop = $("tv-spell-pop");
  const closeSpell = popover($("tv-spell"), spellPop);
  popover($("tv-aa"), $("tv-aa-pop"));
  for (
    const [v, name] of [
      ...Object.entries(WORD_LISTS).map(([v, l]) => [v, l.name]),
      ["none", "None"],
    ]
  ) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "it";
    b.setAttribute("role", "radio");
    b.dataset.spell = v;
    b.innerHTML = '<svg class="tico ck"><use href="#check" /></svg>';
    b.append(name!);
    spellPop.append(b);
  }
  const spells = [...spellPop.querySelectorAll<HTMLElement>("[data-spell]")];

  const apply = () => {
    ed.dataset.view = prefs.view;
    ed.dataset.turns = prefs.turns ? "on" : "off"; // app.css hides them
    // Source's size follows from this one in app.css (13/17 of it).
    ed.style.setProperty("--ed-size", `${prefs.size / 16}rem`); // px at the default root
    ed.style.setProperty(
      "--ed-face",
      prefs.face === "book"
        ? [d.bodyFace(), FACES.alegreya].filter(Boolean).join(", ")
        : FACES[prefs.face],
    );
    editor.requestMeasure(); // a CSS-only size change: re-align line numbers
    check(views, "view", prefs.view);
    check(faces, "face", prefs.face);
    check(dims, "dim", prefs.dim);
    check(spells, "spell", prefs.spell);
    size.textContent = String(prefs.size);
    turns.checked = prefs.turns;
    setWriteView(editor, prefs.view);
    setDim(editor, prefs.dim);
    try {
      localStorage.setItem("text-view", JSON.stringify(prefs));
    } catch {
      // storage blocked: the view just won't survive a reload
    }
  };
  const set = (p: Partial<TextPrefs>) => {
    Object.assign(prefs, p);
    apply();
  };
  for (const b of views) {
    b.onclick = () => set({ view: b.dataset.view as WriteView });
  }
  for (const b of faces) {
    b.onclick = () => set({ face: b.dataset.face as TextPrefs["face"] });
  }
  for (const b of dims) {
    b.onclick = () => set({ dim: b.dataset.dim as Dim });
  }
  for (const b of all("[data-step]")) {
    b.onclick = () =>
      set({
        size: Math.min(24, Math.max(12, prefs.size + Number(b.dataset.step))),
      });
  }
  turns.onchange = () => set({ turns: turns.checked });
  for (const b of spells) {
    b.onclick = () => {
      set({ spell: b.dataset.spell! });
      closeSpell();
      spellCheck(d, prefs.spell, () => prefs.spell);
    };
  }
  apply();
  spellCheck(d, prefs.spell, () => prefs.spell);
  return {
    toggleView: () =>
      set({ view: prefs.view === "prose" ? "source" : "prose" }),
    prefs: () => ({ ...prefs }),
    refresh: () => {
      if (prefs.face === "book") apply();
    },
  };
}
