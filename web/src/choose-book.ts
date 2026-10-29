// web/src/choose-book.ts — Choose a book (spec §7.9): what a bare address on a
// library with books opens, in place of guessing which one.
import { titleCase } from "../../server/editions.ts";
import { matchBooks } from "./switcher.ts";
import { lastBookKey, type whereBooks } from "./library.ts";
import { $, store } from "./dom.ts";

export function chooseBook(o: {
  books: string[];
  where: ReturnType<typeof whereBooks>;
  onChange?: () => void;
  onNew: () => void;
}): Promise<string> {
  const dlg = $("choose") as HTMLDialogElement;
  const search = $("choose-search") as HTMLInputElement;
  const list = $("choose-list");
  const last = store(lastBookKey(o.where));
  let sel = last && o.books.includes(last) ? last : o.books[0]!;

  $("choose-where").replaceChildren(
    `${o.books.length} in `,
    o.where.kind === "browser"
      ? "this browser"
      : Object.assign(document.createElement("span"), {
        className: "hivis",
        textContent: o.where.name,
      }),
  );
  const change = $("choose-change");
  change.hidden = !o.onChange;
  change.onclick = () => o.onChange?.();
  $("choose-new").onclick = o.onNew;

  return new Promise((resolve) => {
    const open = (b: string) => {
      dlg.close();
      resolve(b);
    };
    const render = () => {
      const hits = matchBooks(o.books, search.value);
      if (!hits.includes(sel) && hits[0]) sel = hits[0];
      list.replaceChildren(...hits.map((b) => {
        const row = document.createElement("button");
        row.className = "choose-row";
        row.tabIndex = -1; // the search box's arrows walk these
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(b === sel));
        row.title = b;
        row.append(Object.assign(document.createElement("span"), {
          textContent: titleCase(b),
        }));
        if (b === last) {
          row.append(Object.assign(document.createElement("small"), {
            textContent: "Last open",
          }));
        }
        row.onclick = () => open(b);
        return row;
      }));
      if (!hits.length) {
        list.append(Object.assign(document.createElement("div"), {
          className: "book-empty",
          textContent: "No books match",
        }));
      }
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({
        block: "nearest",
      });
    };
    search.value = "";
    search.oninput = render;
    search.onkeydown = (e) => {
      const hits = matchBooks(o.books, search.value);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = hits.indexOf(sel) + (e.key === "ArrowDown" ? 1 : -1);
        const next = hits[Math.min(Math.max(i, 0), hits.length - 1)];
        if (next) sel = next;
        render();
      } else if (e.key === "Escape" && search.value) {
        search.value = "";
        render();
      } else if (e.key === "Enter" && hits.includes(sel)) {
        e.preventDefault();
        open(sel);
      }
    };
    // No book is open behind it. Chrome lets a second unanswered esc through
    // the cancel event, so the key itself is stopped too.
    dlg.oncancel = (e) => e.preventDefault();
    dlg.onkeydown = (e) => {
      if (e.key === "Escape") e.preventDefault();
    };
    render();
    dlg.showModal();
  });
}
