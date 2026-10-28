// web/src/create-book.ts — Create a new manuscript (spec §7.9): the create
// dialog (import a file or a web page, copy books in from a folder, or start
// blank), the title dialog with its theme cards, and the web dialog; plus the
// footer's import notes, the `%% check:` lines an import leaves.
import type { EditorView } from "@codemirror/view";
import type { Backend } from "./backend.ts";
import { scrollEditorToLine } from "./editor.ts";
import { editionHref, slugify } from "./editions.ts";
import { titleCase } from "../../server/editions.ts";
import { importBooks } from "./fs-store.ts";
import { importSource } from "../../server/import/mod.ts";
import { arrowKeys, themeCard } from "./panel-themes.ts";
import { THEMES } from "../../metadata/themes.ts";
import {
  fetchSource,
  openUrl,
  pasteSource,
  type WebSource,
} from "./web-source.ts";
import { $, brief } from "./dom.ts";
import { label } from "./keys.ts";

export interface CreateBookDeps {
  backend(): Backend; // a Back to the Welcome connects again
  books(): string[]; // the library's books, as last listed
  setBooks(books: string[]): void; // after a folder import copied some in
  leave(href: string): Promise<void>;
  restart(): void; // main again: Back from an empty library
}

/** Returns `createManuscript(cancelable)`, the dialog's opener. */
export function installCreateBook(
  d: CreateBookDeps,
): (cancelable: boolean) => void {
  // Import a file or a web page, or start blank; all ask for a title, then open
  // the book.
  // `cancelable` is false for an empty library; there Back returns to the
  // Welcome (no server only: with one, the library is the server's folder).
  function createManuscript(cancelable: boolean): void {
    const dlg = $("create") as HTMLDialogElement;
    const err = $("create-err");
    err.textContent = "";
    $("create-head").classList.toggle("empty", !cancelable);
    $("create-title").textContent = cancelable
      ? "Create a new manuscript"
      : "Your library is empty";
    $("create-sub").textContent = cancelable
      ? "Add another book to this library."
      : "How do you want to begin?";
    const cancel = $("create-cancel");
    cancel.hidden = !cancelable;
    cancel.onclick = () => dlg.close();
    const back = $("create-back");
    back.hidden = cancelable || d.backend().kind !== "local";
    back.onclick = () => {
      dlg.close();
      localStorage.removeItem("library");
      d.restart();
    };
    dlg.oncancel = (e) => {
      e.preventDefault();
      if (!back.hidden) back.click();
      else if (cancelable) cancel.click();
    };
    const input = $("create-file") as HTMLInputElement;
    input.value = "";
    $("create-import").onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      err.textContent = "Reading…";
      await importPicked(
        {
          name: file.name,
          bytes: file.arrayBuffer().then((b) => new Uint8Array(b)),
        },
        `${file.name} · ${sizeLabel(file.size)}`,
        cancelable,
      );
    };
    $("create-web").onclick = async () => {
      dlg.close();
      const src = await askWebSource();
      if (!src) return createManuscript(cancelable);
      await importPicked(src, src.label, cancelable);
    };
    // A browser-storage library can copy books in from a Wynkyn folder on
    // disk: the way in for a browser that can't open the folder itself.
    const folder = $("create-folder");
    folder.hidden = localStorage.getItem("library") !== "browser";
    const dir = $("create-dir") as HTMLInputElement;
    dir.value = "";
    folder.onclick = () => dir.click();
    dir.onchange = async () => {
      if (!dir.files?.length) return;
      try {
        err.textContent = "Copying…";
        const { written, skipped } = await importBooks(
          d.backend().store!,
          dir.files,
        );
        const first = written[0];
        // Nothing skipped, or nowhere else to go: open the first book copied.
        if (first && (!skipped.length || !cancelable)) {
          await d.leave(editionHref(first, null));
          return;
        }
        if (!skipped.length) {
          err.textContent =
            "No book found: a book is a folder with a manuscript.md.";
          return;
        }
        err.textContent = `Already in the library: ${skipped.join(", ")}.` +
          (first ? ` Copied ${written.map(titleCase).join(", ")}.` : "");
        if (first) d.setBooks((await d.backend().listBooks()).books);
      } catch (e) {
        err.textContent = brief(e);
      }
    };
    $("create-blank").onclick = async () => {
      dlg.close();
      try {
        const got = await askTitle("", null, "Create book");
        if (!got) return createManuscript(cancelable);
        await d.backend().createBook(got.slug, got.title, got.theme);
        await d.leave(editionHref(got.slug, null));
      } catch (e) {
        err.textContent = brief(e);
        dlg.showModal();
      }
    };
    dlg.showModal();
  }

  /** The one import step for a file, a fetched page or a pasted one: read it,
   *  ask for a title under `label`, write the book and open it. Errors go back
   *  to the create dialog. */
  async function importPicked(
    src: {
      name: string;
      bytes: Uint8Array | Promise<Uint8Array>;
      from?: string;
    },
    label: string,
    cancelable: boolean,
  ): Promise<void> {
    const dlg = $("create") as HTMLDialogElement;
    const err = $("create-err");
    try {
      const bytes = await src.bytes;
      const r = importSource(src.name, bytes, { from: src.from });
      err.textContent = "";
      dlg.close();
      const got = await askTitle(r.title, label, "Import");
      if (!got) return createManuscript(cancelable);
      const book = got.title === r.title
        ? r
        : importSource(src.name, bytes, { from: src.from, title: got.title });
      await d.backend().importBook(got.slug, book, got.theme);
      await d.leave(editionHref(got.slug, null));
    } catch (e) {
      err.textContent = brief(e);
      if (!dlg.open) dlg.showModal();
    }
  }

  const sizeLabel = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  // The title dialog's theme cards, built once; each opening starts on House.
  let titleTheme = "house";
  function themePicker(): void {
    const grid = $("title-themes");
    const sub = $("title-theme-sub");
    const pick = (slug: string) => {
      titleTheme = slug;
      for (const c of grid.querySelectorAll<HTMLElement>(".tcard")) {
        c.setAttribute("aria-pressed", String(c.dataset.slug === slug));
      }
      const t = THEMES.find((t) => t.slug === slug)!;
      sub.textContent = `${t.name}: ${t.description}`;
    };
    if (!grid.childElementCount) {
      for (const t of THEMES) {
        const card = themeCard(t, "small");
        card.onclick = () => pick(t.slug);
        grid.append(card);
      }
      arrowKeys(grid);
    }
    pick("house");
  }

  /** The title dialog: the title, its slug and the picked theme, or null for
   *  Back. */
  function askTitle(
    title: string,
    source: string | null,
    cta: string,
  ): Promise<{ slug: string; title: string; theme: string } | null> {
    const dlg = $("title-dlg") as HTMLDialogElement;
    const input = $("title-input") as HTMLInputElement;
    const slugEl = $("title-slug");
    const err = $("title-err");
    const src = $("title-source");
    src.hidden = source === null;
    src.textContent = source ?? "";
    $("title-ok").textContent = cta;
    err.textContent = "";
    input.value = title;
    const show = () => {
      slugEl.textContent = `${slugify(input.value) || "untitled"}/`;
    };
    input.oninput = show;
    show();
    themePicker();
    return new Promise((resolve) => {
      const finish = (
        v: { slug: string; title: string; theme: string } | null,
      ) => {
        dlg.close();
        resolve(v);
      };
      $("title-back").onclick = () => finish(null);
      ($("title-form") as HTMLFormElement).onsubmit = (e) => {
        e.preventDefault();
        const slug = slugify(input.value) || "untitled";
        if (d.books().includes(slug)) {
          err.textContent = `“${slug}” is taken; pick another title.`;
          return;
        }
        finish({ slug, title: input.value, theme: titleTheme });
      };
      dlg.oncancel = (e) => {
        e.preventDefault();
        finish(null);
      };
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  /** The web dialog: an address to fetch, or, when the site blocks that, the
   *  page pasted from a new tab. The source plus its title-dialog line, or null
   *  for Back. */
  function askWebSource(): Promise<(WebSource & { label: string }) | null> {
    const dlg = $("web-dlg") as HTMLDialogElement;
    const url = $("web-url") as HTMLInputElement;
    const box = $("web-paste-box");
    const open = $("web-open") as HTMLAnchorElement;
    const paste = $("web-paste") as HTMLTextAreaElement;
    const err = $("web-err");
    $("web-paste-hint").textContent =
      `That site doesn’t let a web page read it. Open it in a new tab, select all (${
        label("mod+a")
      }), copy (${label("mod+c")}), and paste it here.`;
    box.hidden = true;
    err.textContent = "";
    url.oninput = () => {
      box.hidden = true;
    };
    return new Promise((resolve) => {
      const finish = (src: WebSource | null, label = "") => {
        dlg.close();
        resolve(
          src && { ...src, label: `${label} · ${sizeLabel(src.bytes.length)}` },
        );
      };
      $("web-back").onclick = () => finish(null);
      dlg.oncancel = (e) => {
        e.preventDefault();
        finish(null);
      };
      ($("web-form") as HTMLFormElement).onsubmit = async (e) => {
        e.preventDefault();
        const addr = url.value.trim();
        url.value = addr.includes("://") ? addr : `https://${addr}`;
        const fetchBtn = $("web-fetch") as HTMLButtonElement;
        fetchBtn.disabled = true; // Enter does nothing while the default button is off
        err.textContent = "Fetching…";
        try {
          finish(await fetchSource(url.value), url.value);
        } catch (e) {
          if (!(e instanceof TypeError)) { // not CORS, offline or a bad host
            err.textContent = brief(e);
            return;
          }
          err.textContent = "";
          open.href = openUrl(url.value);
          box.hidden = false;
          paste.focus();
        } finally {
          fetchBtn.disabled = false;
        }
      };
      paste.onpaste = (e) => {
        e.preventDefault();
        const src = e.clipboardData && pasteSource(e.clipboardData, url.value);
        if (!src) {
          err.textContent = "Nothing to paste: copy the page first.";
          return;
        }
        finish(src, `Pasted from ${src.from}`);
      };
      dlg.showModal();
    });
  }

  return createManuscript;
}

// ---- Import notes (spec §7.9): the `%% check:` lines, listed in the footer --
export function renderImportNotes(text: string, editor: EditorView): void {
  const btn = $("import-notes");
  const list = $("import-notes-list");
  const notes = text.split("\n").flatMap((l, i) =>
    l.startsWith("%% check:") ? [{ line: i + 1, text: l.slice(9).trim() }] : []
  );
  btn.hidden = !notes.length;
  if (!notes.length) {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  btn.textContent = `${notes.length} import note${
    notes.length > 1 ? "s" : ""
  } to check`;
  list.replaceChildren();
  const h = document.createElement("div");
  h.className = "h";
  h.textContent =
    "Places the importer guessed. Click one to go there; delete the %% check: line when you’re happy with it.";
  list.append(h);
  for (const n of notes) {
    const b = document.createElement("button");
    b.type = "button";
    const l = document.createElement("span");
    l.className = "l";
    l.textContent = `line ${n.line}`;
    const t = document.createElement("span");
    t.textContent = n.text;
    b.append(l, t);
    b.onclick = () => {
      list.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      scrollEditorToLine(editor, n.line);
      editor.focus();
    };
    list.append(b);
  }
  btn.onclick = () => {
    list.hidden = !list.hidden;
    btn.setAttribute("aria-expanded", String(!list.hidden));
  };
}
