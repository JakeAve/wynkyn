// web/src/library.ts — where the books live: the dev server's books/, or,
// with no server, a folder the author picks or this browser's private
// storage. The choice is remembered across loads (localStorage "library").
import {
  type Backend,
  hasServer,
  httpBackend,
  localAssets,
  localBackend,
} from "./backend.ts";
import type { BookStore } from "../../server/store.ts";
import {
  browserFolder,
  copyBooks,
  createBooksFolder,
  handleStore,
  pickFolder,
  rememberedFolder,
  rememberFolder,
  reopenFolder,
} from "./fs-store.ts";
import { titleCase } from "../../server/editions.ts";
import { $, brief, store } from "./dom.ts";

type Dir = FileSystemDirectoryHandle;
type Kind = "folder" | "browser";
type Row = "lib-new" | "lib-pick" | "lib-browser";
type Rows = [Row, string, string][]; // id, title, note (HTML), in order

const KEEP = "Keep books in this browser";
const WELCOME: Rows = [
  ["lib-new", "Create a new folder", "Wynkyn creates a folder on your device."],
  [
    "lib-pick",
    "Open a folder I already have",
    "An existing folder where you have Wynkyn books saved.",
  ],
  [
    "lib-browser",
    KEEP,
    "Nothing to set up. Browsers can clear site storage, so " +
    "<b>download what you want to keep</b>.",
  ],
];
const BACK: Rows = [
  ["lib-pick", "Open a different folder", ""],
  ["lib-new", "Create a new folder", ""],
  ["lib-browser", KEEP, ""],
];
const FROM_FOLDER: Rows = [
  [
    "lib-pick",
    "Open a different folder",
    "Another Wynkyn books folder on this device.",
  ],
  ["lib-new", "Create a new folder", "Start an empty library somewhere else."],
  [
    "lib-browser",
    KEEP,
    "Browsers can clear site storage, so download what you want to keep.",
  ],
];

const hivis = (name: string) =>
  Object.assign(document.createElement("span"), {
    className: "hivis",
    textContent: name,
  });
const count = (n: number) => `${n} book${n === 1 ? "" : "s"}`;
// Persisted storage is evicted last; the browser may still say no.
const persist = () => navigator.storage.persist?.().catch(() => false);

// The folder connect() opened: IndexedDB may not be readable again.
let opened = "";

function whereLocal(): { kind: Kind; name: string } {
  return store("library") === "browser"
    ? { kind: "browser", name: "This browser" }
    : { kind: "folder", name: opened };
}

// Per library: a book of the same name elsewhere is another book.
export const lastBookKey = (w: { kind: string; name: string }): string =>
  `last-book:${w.kind}:${w.name}`;

export function whereBooks(
  backend: Backend,
): { kind: "server" | "folder" | "browser"; name: string } {
  return backend.kind === "http"
    ? { kind: "server", name: "books" }
    : whereLocal();
}

// One markup, three modes (spec §7.9). Returns the dialog with its rows
// laid out; the caller wires the clicks.
function layout(
  mode: "welcome" | "back" | "change",
  rows: Rows,
  lead: string,
): HTMLDialogElement {
  $("library-title").textContent = {
    welcome: "Welcome to Wynkyn",
    back: "Welcome back",
    change: "Change library",
  }[mode];
  const p = $("lib-lead");
  p.textContent = lead;
  p.hidden = !lead;
  $("lib-reopen").hidden = $("lib-else").hidden = mode !== "back";
  $("lib-now").hidden = $("lib-foot").hidden = mode !== "change";
  $("lib-next").hidden = true;
  $("lib-err").textContent = "";
  const box = $("lib-rows");
  for (const id of ["lib-new", "lib-pick", "lib-browser"]) $(id).hidden = true;
  rows.forEach(([id, title, note], i) => {
    const b = $(id);
    b.hidden = false;
    b.classList.toggle("primary", mode === "welcome" && i === 0);
    b.classList.toggle("sm", mode === "back");
    b.querySelector(".t")!.textContent = title;
    b.querySelector("small")!.innerHTML = note;
    box.append(b);
  });
  // Without the File System Access API (Firefox, Safari, Brave until its
  // flag is on) the folder buttons stay live and are tagged: a click fails
  // with the browser's own error, which tells the author whose limit it is.
  const tagged = !("showDirectoryPicker" in globalThis);
  for (const id of ["lib-new", "lib-pick"]) {
    ($(id).querySelector(".pill") as HTMLElement).hidden = !tagged;
  }
  return $("library") as HTMLDialogElement;
}

function wire(go: (kind: Kind, get: () => Promise<Dir>) => Promise<void>) {
  const fail = (e: unknown) => {
    if ((e as Error).name !== "AbortError") $("lib-err").textContent = brief(e);
  };
  $("lib-new").onclick = () => go("folder", createBooksFolder).catch(fail);
  $("lib-pick").onclick = () => go("folder", pickFolder).catch(fail);
  $("lib-browser").onclick = () => go("browser", browserFolder).catch(fail);
}

// Without a server the app needs a folder: the author's own books/ (the File
// System Access API, Chromium), or this browser's private storage.
async function chooseLibrary(): Promise<Dir> {
  const remembered = await rememberedFolder();
  const pref = store("library");
  if (pref === "browser") return await browserFolder();
  const granted = remembered && await reopenFolder(remembered, false);
  if (granted && pref === "folder") return remembered;
  return new Promise((resolve) => {
    const dlg = layout(
      remembered ? "back" : "welcome",
      remembered ? BACK : WELCOME,
      !remembered
        ? "Choose where your books will live. You can change it later."
        : granted
        ? ""
        : "Chrome asks again before Wynkyn can open your books folder.",
    );
    const done = (dir: Dir, kind: Kind) => {
      store("library", kind);
      if (kind === "browser") persist();
      dlg.close();
      resolve(dir);
    };
    if (remembered) {
      const reopen = $("lib-reopen");
      const last = store(
        lastBookKey({ kind: "folder", name: remembered.name }),
      );
      reopen.lastElementChild!.replaceChildren(
        "Open ",
        hivis(remembered.name),
        " again",
        Object.assign(document.createElement("small"), {
          textContent: last ? `Last open: ${titleCase(last)}` : "",
        }),
      );
      reopen.onclick = async () => {
        if (await reopenFolder(remembered, true)) {
          done(remembered, "folder");
        } else $("lib-err").textContent = "The folder wasn't allowed.";
      };
    }
    wire(async (kind, get) => done(await get(), kind));
    dlg.showModal();
  });
}

// The folder crumb: the other kinds of library, with the current one named.
// A pick reloads to the bare path; from this browser to a folder it first
// offers to copy the books the folder lacks (#bring).
export function changeLibrary(o: {
  store: BookStore;
  books: string[];
  leave(href: string): Promise<boolean>;
}): void {
  void (async () => {
    const now = whereLocal();
    const was = { pref: store("library"), dir: await rememberedFolder() };
    const fromBrowser = now.kind === "browser";
    const dlg = layout(
      "change",
      fromBrowser ? WELCOME.slice(0, 2) : FROM_FOLDER,
      "",
    );
    $("lib-now-where").replaceChildren(
      ...fromBrowser
        ? ["Now: this browser"]
        : ["Now: the ", hivis(now.name), " folder"],
    );
    $("lib-now-count").textContent = count(o.books.length);
    $("lib-next").hidden = !fromBrowser || !o.books.length;
    $("lib-cancel").onclick = () => dlg.close();
    const finish = async (kind: Kind) => {
      dlg.close();
      store("library", kind);
      if (kind === "browser") persist();
      if (await o.leave(location.pathname)) return;
      // Stayed for unsaved changes: the next load opens this library again.
      if (was.pref) store("library", was.pref);
      if (was.dir) await rememberFolder(was.dir);
    };
    wire(async (kind, get) => {
      if (kind === "browser") return finish(kind);
      const dir = await get();
      const to = handleStore(dir);
      const has = fromBrowser
        ? await Promise.all(o.books.map((b) => to.exists(`${b}/manuscript.md`)))
        : [];
      const fresh = o.books.filter((_, i) => has[i] === false);
      if (!fresh.length) return finish(kind);
      dlg.close();
      bring(o.store, to, dir.name, fresh, o.books.filter((_, i) => has[i]))
        .then(() => finish(kind));
    });
    dlg.showModal();
  })();
}

// Resolves once the author has answered; a failed copy shows and stays.
function bring(
  from: BookStore,
  to: BookStore,
  name: string,
  fresh: string[],
  clash: string[],
): Promise<void> {
  const dlg = $("bring") as HTMLDialogElement;
  for (const el of dlg.querySelectorAll(".bring-name")) el.textContent = name;
  $("bring-count").textContent = count(fresh.length);
  for (const el of dlg.querySelectorAll<HTMLElement>("[data-one]")) {
    el.dataset.many ??= el.textContent!;
    el.textContent = fresh.length === 1 ? el.dataset.one! : el.dataset.many;
  }
  $("bring-clash").hidden = !clash.length;
  $("bring-clash-titles").textContent = clash.map(titleCase).join(", ");
  const err = $("bring-err");
  err.textContent = "";
  return new Promise((resolve) => {
    const done = () => {
      dlg.close();
      resolve();
    };
    $("bring-copy").onclick = async () => {
      try {
        await copyBooks(from, to, fresh);
        done();
      } catch (e) {
        err.textContent = brief(e);
      }
    };
    $("bring-skip").onclick = done;
    dlg.showModal();
  });
}

// Without the File System Access API (Firefox, Safari, Brave by default) the
// app can't open the author's folder: say so once, before the Welcome, and
// point at the browsers that can. The Welcome itself is the same everywhere.
function browserNotice(): Promise<void> {
  if (
    "showDirectoryPicker" in globalThis ||
    localStorage.getItem("browser-notice") === "1"
  ) return Promise.resolve();
  const dlg = $("browser-notice") as HTMLDialogElement;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      localStorage.setItem("browser-notice", "1");
      resolve();
    };
    $("browser-notice-close").onclick = () => dlg.close();
    dlg.showModal();
  });
}

export async function connect(): Promise<Backend> {
  if (await hasServer()) return httpBackend();
  const assets = localAssets();
  await browserNotice();
  const dir = await chooseLibrary();
  opened = dir.name;
  return await localBackend(dir, await assets);
}
