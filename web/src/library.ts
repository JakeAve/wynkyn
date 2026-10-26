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
import {
  browserFolder,
  createBooksFolder,
  pickFolder,
  rememberedFolder,
  reopenFolder,
} from "./fs-store.ts";
import { $, brief } from "./dom.ts";

// Without a server the app needs a folder: the author's own books/ (the File
// System Access API, Chromium), or this browser's private storage. The choice
// is remembered; "Change library…" in the switcher forgets it. The folder buttons
// show in every browser: one without the API (Firefox, Safari, Brave until its
// flag is on) fails the click with its own error rather than hiding the
// options.
async function chooseLibrary(): Promise<FileSystemDirectoryHandle> {
  const remembered = await rememberedFolder();
  const pref = localStorage.getItem("library");
  if (
    pref === "folder" && remembered && await reopenFolder(remembered, false)
  ) return remembered;
  if (pref === "browser") return await browserFolder();
  return new Promise((resolve) => {
    const dlg = $("library") as HTMLDialogElement;
    const err = $("lib-err");
    // Persisted storage is evicted last; the browser may still say no.
    const persist = () => navigator.storage.persist?.().catch(() => false);
    const done = (
      dir: FileSystemDirectoryHandle,
      kind: "folder" | "browser",
    ) => {
      localStorage.setItem("library", kind);
      if (kind === "browser") persist();
      dlg.close();
      resolve(dir);
    };
    const fail = (e: unknown) => {
      if ((e as Error).name !== "AbortError") err.textContent = brief(e);
    };
    const reopen = $("lib-reopen");
    reopen.hidden = !remembered;
    if (remembered) {
      reopen.textContent = `Open “${remembered.name}” again`;
      reopen.onclick = async () => {
        if (await reopenFolder(remembered, true)) {
          done(remembered, "folder");
        } else err.textContent = "The folder wasn't allowed.";
      };
    }
    // Without the File System Access API (Firefox, Safari, Brave until its
    // flag is on) the folder buttons stay live and are tagged: a click fails
    // with the browser's own error, which tells the author whose limit it is.
    const tagged = !("showDirectoryPicker" in globalThis);
    for (const id of ["lib-new", "lib-pick"]) {
      ($(id).querySelector(".pill") as HTMLElement).hidden = !tagged;
    }
    $("lib-new").onclick = () =>
      createBooksFolder().then((d) => done(d, "folder"), fail);
    $("lib-pick").onclick = () =>
      pickFolder().then((d) => done(d, "folder"), fail);
    $("lib-browser").onclick = () =>
      browserFolder().then((d) => done(d, "browser"), fail);
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
  return await localBackend(await chooseLibrary(), await assets);
}
