// web/src/switcher.ts — the crumb (Book / Edition · size) and the switcher it
// opens: books with search, the selected book's editions with Rename, Delete
// and New edition, and in browser storage the book and library as zips.
// Installed once a book and edition are open; app.ts hands in what it owns.
import type { EditorView } from "@codemirror/view";
import { parse } from "../../parser/parser.ts";
import type { Mode } from "./preview.ts";
import type { Backend } from "./backend.ts";
import type { Sync } from "./sync.ts";
import { scrollEditorToLine } from "./editor.ts";
import { cacheId, deleteCachedRender } from "./preview-cache.ts";
import {
  editionHref,
  type EditionInfo,
  firstSpanLine,
  passagesLabel,
  prettySize,
  slugify,
} from "./editions.ts";
import { titleCase } from "../../server/editions.ts";
import { zipBook, zipLibrary } from "./book-zip.ts";
import { changeLibrary, type whereBooks } from "./library.ts";
import { $, brief } from "./dom.ts";

type Where = Awaited<ReturnType<typeof whereBooks>>;

const BROWSER_NOTE = "Your library is currently in browser storage and " +
  "could be cleared by your browser at any time.";

// Before a book is chosen; the dev server's books/ has no other library.
export function showLibrary(
  backend: Backend,
  where: Where,
  leave: (href: string) => Promise<boolean>,
): void {
  const lib = $("library-open");
  lib.hidden = $("library-slash").hidden = backend.kind !== "local";
  if (lib.hidden) return;
  $("library-icon").setAttribute(
    "href",
    where.kind === "browser" ? "#where-browser" : "#where-folder",
  );
  $("library-name").textContent = where.name;
  lib.title = where.kind === "browser"
    ? BROWSER_NOTE
    : `Books in the “${where.name}” folder on this device. Click to change.`;
  lib.ariaLabel = `Library: ${where.name}. Change library`;
  // Listed afresh: another tab may have added a book since this one loaded.
  lib.onclick = async () =>
    changeLibrary({
      store: backend.store!,
      books: (await backend.listBooks()).books,
      leave,
    });
}

export interface SwitcherDeps {
  backend: Backend;
  where: Where;
  book: string; // the open book and edition
  edition: string | null;
  editions: EditionInfo[]; // the open book's, for the crumb
  books(): string[]; // the library's books, as last listed
  sync(): Sync;
  editor(): EditorView;
  leave(href: string): Promise<boolean>;
  setMode(mode: Mode): void;
  createManuscript(cancelable: boolean): void;
  rebaseAfterRename(): Promise<void>;
}

export interface Switcher {
  setCrumbSize(size: string | undefined): void;
  renaming(): Promise<unknown>; // this tab's edition rename, settled or not
}

export function matchBooks(books: string[], q: string): string[] {
  q = q.trim().toLowerCase();
  return books.filter((b) =>
    !q || b.includes(q) || titleCase(b).toLowerCase().includes(q)
  );
}

export function installSwitcher(d: SwitcherDeps): Switcher {
  const { backend, book, edition, leave, setMode, createManuscript } = d;
  let renaming: Promise<unknown> = Promise.resolve(); // this tab's edition rename

  // The crumb: Book / Edition, then what sets the edition apart — its page size.
  function setCrumb(editions: EditionInfo[]): void {
    const cur = editions.find((e) => e.slug === edition);
    const name = cur?.name ?? "";
    $("book-name").textContent = titleCase(book);
    $("crumb-book").hidden = false;
    $("edition-name").textContent = name;
    document.title = `Wynkyn — ${book} · ${name}`;
  }
  function setCrumbSize(size: string | undefined): void {
    $("edition-size").textContent = size ? prettySize(size) : "";
  }

  // The switcher: books (with search) on the left, the selected book's editions
  // on the right. Every open re-fetches, so summaries follow page-size edits.
  let selBook = ""; // the book whose editions the right side lists
  let selEditions: EditionInfo[] = [];
  let selGen = 0;
  const switcher = () => $("switcher") as HTMLDialogElement;
  const bookSearch = () => $("book-search") as HTMLInputElement;
  const newForm = () => $("edition-new-form") as HTMLFormElement;

  const bookHits = () => matchBooks(d.books(), bookSearch().value);

  function renderBooks(): void {
    const hits = bookHits();
    const rows: HTMLElement[] = hits.map((b) => {
      const row = document.createElement("button");
      row.className = "book-row";
      row.tabIndex = -1; // the search box's arrows walk these
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(b === selBook));
      row.textContent = titleCase(b);
      row.title = b;
      row.onclick = () => selectBook(b);
      row.ondblclick = () => openEdition(b, b === book ? edition : null);
      return row;
    });
    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "book-empty";
      empty.textContent = "No books match";
      rows.push(empty);
    }
    $("book-list").replaceChildren(...rows);
    $("book-list").querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }

  async function selectBook(b: string): Promise<void> {
    selBook = b;
    $("eds-book").textContent = titleCase(b);
    renderBooks();
    hideNewForm();
    const gen = ++selGen;
    try {
      const eds = await backend.editions(b);
      if (gen !== selGen) return;
      selEditions = eds;
      if (b === book) setCrumb(eds);
    } catch (err) {
      if (gen !== selGen) return;
      selEditions = [];
      const msg = document.createElement("div");
      msg.className = "sw-err";
      msg.textContent = `editions: ${brief(err)}`;
      $("edition-list").replaceChildren(msg);
      return;
    }
    renderEditions();
  }

  // Full navigation, not in-place teardown: clean WS/d.editor()/tree state. A line
  // rides along in the hash for main() to jump the d.editor() to.
  function openEdition(b: string, slug: string | null, line?: number): void {
    if (b === book && slug === edition) {
      switcher().close();
      if (line) {
        setMode("write");
        scrollEditorToLine(d.editor(), line);
      }
      return;
    }
    void leave(editionHref(b, slug) + (line ? `#line=${line}` : ""));
  }

  function renderEditions(): void {
    const current = selBook === book ? edition : undefined;
    $("edition-list").replaceChildren(...selEditions.map((e) => {
      const row = document.createElement("div");
      row.className = "ed-row";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const ck = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      ck.setAttribute("class", "tico ck");
      if (e.slug === current) {
        row.setAttribute("aria-current", "true");
        const use = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "use",
        );
        use.setAttribute("href", "#check");
        ck.append(use);
      }
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = e.name;
      const err = document.createElement("span");
      err.className = "sw-err";
      const acts = document.createElement("span");
      acts.className = "acts";
      const act = (label: string, fn: () => void | Promise<void>) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = async (ev) => {
          ev.stopPropagation();
          err.textContent = "";
          try {
            await fn();
          } catch (x) {
            err.textContent = brief(x);
          }
        };
        acts.append(b);
      };
      act("Rename", () => {
        const input = document.createElement("input");
        input.value = e.name;
        input.setAttribute("aria-label", "Edition name");
        input.onclick = (ev) => ev.stopPropagation();
        input.onkeydown = (ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault(); // cancel the rename, not the switcher
            renderEditions();
          } else if (ev.key === "Enter") {
            ev.preventDefault();
            err.textContent = "";
            renameEdition(e, input.value).catch((x) =>
              err.textContent = brief(x)
            );
          }
        };
        nm.replaceChildren(input);
        input.select();
      });
      const slug = e.slug;
      if (slug !== null) {
        act("Delete", async () => {
          if (
            !confirm(
              `Delete the ${e.name} edition? The manuscript is untouched.`,
            )
          ) return;
          // Style edits waiting for the open edition go with it.
          if (selBook === book && slug === edition) d.sync().dropMetadata();
          await backend.deleteEdition(selBook, slug);
          await deleteCachedRender(cacheId(selBook, slug));
          if (selBook === book && slug === edition) {
            await leave(editionHref(book, null));
          } else await selectBook(selBook);
        });
      }
      const setup = document.createElement("span");
      setup.className = "setup";
      setup.textContent = e.summary;
      row.append(ck, nm, acts, setup);
      if (e.passages > 0) {
        const diff = document.createElement("button");
        diff.className = "diff";
        diff.textContent = passagesLabel(e.passages);
        diff.title = "Open this edition at its first passage";
        diff.onclick = (ev) => {
          ev.stopPropagation();
          jumpToPassages(e.slug).catch((x) => err.textContent = brief(x));
        };
        row.append(diff);
      }
      row.append(err);
      row.onclick = () => openEdition(selBook, e.slug);
      row.onkeydown = (ev) => {
        if (ev.target !== row) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault(); // don't let Space scroll the list
          openEdition(selBook, e.slug);
        } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          ((ev.key === "ArrowDown"
            ? row.nextElementSibling
            : row.previousElementSibling) as HTMLElement | null)?.focus();
        }
      };
      return row;
    }));
  }

  // Named editions rename by slug (the server rewrites their {only} tokens);
  // the default edition only has a display name to change.
  async function renameEdition(e: EditionInfo, value: string): Promise<void> {
    if (e.slug === null) {
      await backend.renameDefault(selBook, value);
    } else {
      const next = slugify(value);
      if (!next) throw new Error("the name needs a letter or digit");
      if (next !== e.slug) {
        // Style edits waiting for the open edition land first, and move with it.
        if (selBook === book && e.slug === edition) await d.sync().flush();
        const done = backend.renameEdition(selBook, e.slug, next)
          .then(() => selBook === book ? d.rebaseAfterRename() : undefined);
        renaming = done.catch(() => {});
        await done;
        await deleteCachedRender(cacheId(selBook, e.slug));
        if (selBook === book && e.slug === edition) {
          await leave(editionHref(book, next));
          return;
        }
      }
    }
    await selectBook(selBook);
  }

  async function jumpToPassages(slug: string | null): Promise<void> {
    const text = selBook === book
      ? d.editor().state.doc.toString()
      : (await backend.manuscript(selBook)).text;
    openEdition(
      selBook,
      slug,
      firstSpanLine(parse(text).onlySpans, slug) ?? undefined,
    );
  }

  function hideNewForm(): void {
    newForm().hidden = true;
    $("edition-new").hidden = false;
  }

  setCrumb(d.editions);
  const dialog = switcher();
  const search = bookSearch();
  const form = newForm();
  const nameInput = form.elements.namedItem("name") as HTMLInputElement;
  const from = form.elements.namedItem("from") as HTMLSelectElement;
  const formErr = form.querySelector(".sw-err")!;
  const crumbs = [$("book-switcher"), $("edition-switcher")];

  search.oninput = () => {
    const hits = bookHits();
    if (!hits.includes(selBook) && hits[0]) selectBook(hits[0]);
    else renderBooks();
  };
  search.onkeydown = (e) => {
    const hits = bookHits();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = hits.indexOf(selBook) + (e.key === "ArrowDown" ? 1 : -1);
      const next = hits[Math.min(Math.max(i, 0), hits.length - 1)];
      if (next && next !== selBook) selectBook(next);
    } else if (e.key === "Enter" && hits.includes(selBook)) {
      e.preventDefault();
      openEdition(selBook, selBook === book ? edition : null);
    }
  };
  for (const b of crumbs) {
    b.onclick = () => {
      search.value = "";
      dialog.style.left = `${
        $("book-switcher").getBoundingClientRect().left
      }px`;
      dialog.showModal();
      for (const c of crumbs) c.setAttribute("aria-expanded", "true");
      search.focus();
      selectBook(book);
    };
  }
  dialog.onclose = () => {
    for (const c of crumbs) c.setAttribute("aria-expanded", "false");
  };
  dialog.onclick = (e) => {
    if (e.target === dialog) dialog.close(); // a click outside closes
  };

  $("book-new").onclick = () => {
    dialog.close();
    createManuscript(true);
  };
  // Downloads are the way out of browser storage, so only it shows them.
  for (const id of ["eds-head", "library-download", "library-note"]) {
    $(id).hidden = d.where.kind !== "browser";
  }
  $("library-note").textContent = BROWSER_NOTE;
  const save = async (name: string, zip: Promise<Uint8Array<ArrayBuffer>>) => {
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([await zip], { type: "application/zip" }),
      );
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      $("book-err").textContent = brief(err);
    }
  };
  $("book-download").onclick = () =>
    save(
      `${selBook}.zip`,
      zipBook(backend.store!, selBook, {
        history: ($("zip-history") as HTMLInputElement).checked,
      }),
    );
  $("library-download").onclick = () =>
    save("wynkyn-books.zip", zipLibrary(backend.store!, d.books()));

  $("edition-new").onclick = () => {
    from.replaceChildren(
      ...selEditions.map((e) => new Option(e.name, e.slug ?? "default")),
    );
    from.value = (selBook === book ? edition : null) ?? "default";
    nameInput.value = "";
    formErr.textContent = "";
    $("edition-new").hidden = true;
    form.hidden = false;
    nameInput.focus();
  };
  (form.elements.namedItem("cancel") as HTMLButtonElement).onclick =
    hideNewForm;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const slug = slugify(nameInput.value);
    formErr.textContent = slug ? "" : "the name needs a letter or digit";
    if (!slug) return;
    try {
      await backend.createEdition(selBook, slug, from.value);
      await leave(editionHref(selBook, slug));
    } catch (err) {
      formErr.textContent = brief(err);
    }
  };

  return { setCrumbSize, renaming: () => renaming };
}
