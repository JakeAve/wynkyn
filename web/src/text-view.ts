// web/src/text-view.ts — the bar atop the editor: the editor's font and size,
// Hide markup, and Spelling (the word list plus the book's dictionary.json).
// A per-reader preference, kept in localStorage, not the book.
import type { EditorView } from "@codemirror/view";
import type { Backend } from "./backend.ts";
import { setHideMarkup } from "./editor.ts";
import { parseWordList, setSpeller } from "./spelling.ts";
import { $, brief } from "./dom.ts";

export interface TextViewDeps {
  editor: EditorView;
  backend: Backend;
  book: string;
  setStatus(kind: "error", detail: string): void;
}

// Spell check (spec §7.3): the word list the Spelling menu picks, fetched
// once, and the book's dictionary.json, which Add to dictionary grows.
// Another language is one more list in vendor/ and one row here.
const WORD_LISTS: Record<string, { name: string; url: string }> = {
  en: { name: "English", url: "/vendor/words-en.txt" },
};
const wordLists = new Map<string, Promise<Set<string>>>();
async function spellCheck(d: TextViewDeps, lang: string): Promise<void> {
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
    if (($("tv-spell") as HTMLSelectElement).value === lang) {
      setSpeller(editor, speller(new Set(words)));
    }
  } catch (err) {
    wordLists.delete(lang); // try the fetch again next time
    setStatus("error", `spell check: ${brief(err)}`);
  }
}

// The text view (the bar atop the editor): the editor's font and size, Hide markup and Spelling, a per-reader
// preference kept in localStorage, not the book.
const TEXT_FONTS: Record<string, string> = {
  serif: "var(--f-text)",
  sans: "var(--f-ui)",
  mono: "var(--f-mono)",
};
export function installTextView(d: TextViewDeps): void {
  const { editor } = d;
  let prefs = { font: "serif", size: 16, hide: false, spell: "en" };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem("text-view")!) };
  } catch {
    // none saved, or storage blocked: the defaults
  }
  const ed = $("editor");
  const size = $("tv-size") as HTMLInputElement;
  const hide = $("tv-hide") as HTMLInputElement;
  const spell = $("tv-spell") as HTMLSelectElement;
  spell.append(
    ...Object.entries(WORD_LISTS).map(([v, l]) => new Option(l.name, v)),
    new Option("None", "none"),
  );
  if (prefs.spell !== "none" && !(prefs.spell in WORD_LISTS)) {
    prefs.spell = "en";
  }
  const fonts = [
    ...$("text-view").querySelectorAll<HTMLElement>("[data-font]"),
  ];
  const apply = () => {
    ed.style.setProperty("--ed-font", TEXT_FONTS[prefs.font] ?? null);
    ed.style.setProperty("--ed-fs", `${prefs.size}px`);
    editor.requestMeasure(); // a CSS-only size change: re-align line numbers
    for (const b of fonts) {
      b.setAttribute("aria-checked", String(b.dataset.font === prefs.font));
    }
    size.value = String(prefs.size);
    size.nextElementSibling!.textContent = `${prefs.size}px`;
    hide.checked = prefs.hide;
    spell.value = prefs.spell;
    setHideMarkup(editor, prefs.hide);
    try {
      localStorage.setItem("text-view", JSON.stringify(prefs));
    } catch {
      // storage blocked: the view just won't survive a reload
    }
  };
  for (const b of fonts) {
    b.onclick = () => {
      prefs.font = b.dataset.font!;
      apply();
    };
  }
  size.oninput = () => {
    prefs.size = Number(size.value);
    apply();
  };
  for (const b of $("text-view").querySelectorAll<HTMLElement>("[data-step]")) {
    b.onclick = (e) => {
      e.preventDefault(); // inside the label: don't also focus the slider
      size.stepUp(Number(b.dataset.step)); // clamps to the slider's min/max
      prefs.size = Number(size.value);
      apply();
    };
  }
  hide.onchange = () => {
    prefs.hide = hide.checked;
    apply();
  };
  spell.onchange = () => {
    prefs.spell = spell.value;
    apply();
    spellCheck(d, prefs.spell);
  };
  apply();
  spellCheck(d, prefs.spell);
}
