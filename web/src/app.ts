// web/src/app.ts — client orchestrator: book selection, editor, WebSocket, panes.
import { parse } from "../../parser/parser.ts";
import type { EditorView } from "@codemirror/view";
import type { BmlDocument } from "../../parser/types.ts";
import { addIsNames, catalogFor, type EpubResult } from "./style-catalog.ts";
import { parseSentinelLine } from "../../parser/sentinel.ts";
import {
  fitPreview,
  installPageIndicator,
  installPreviewClicks,
  installStyleHover,
  markEdited,
  type Mode,
  previewLink,
  renderPreview,
  restoreCachedRender,
  scrollPreviewTo,
} from "./preview.ts";
import type { ServerMessage } from "../../server/pipeline.ts";
import {
  cacheId,
  deleteCachedRender,
  loadCachedRender,
} from "./preview-cache.ts";
import {
  formatProblem,
  type PageProblem,
} from "../../renderer/page-map-types.ts";
import {
  applyDiagnostics,
  createEditor,
  replaceBuffer,
  scrollEditorToLine,
  setEditionSpans,
  setHideMarkup,
} from "./editor.ts";
import { styleKeysAt } from "./bml-language.ts";
import { SNIPPETS } from "./snippets.ts";
import { insertSnippet } from "./editor-insert.ts";
import { buildTree } from "./tree-data.ts";
import { renderTree } from "./tree-view.ts";
import { type ConfigPanel, createConfigPanel } from "./config-panel.ts";
import type { Metadata } from "../../metadata/types.ts";
import { isNewerSpec, SPEC_VERSION } from "../../metadata/upgrade.ts";
import {
  appHref,
  editionHref,
  type EditionInfo,
  editionLabel,
  firstSpanLine,
  lineFromHash,
  passagesLabel,
  prettySize,
  slugify,
} from "./editions.ts";
import { editionToken, titleCase } from "../../server/editions.ts";
import { zipBook } from "./book-zip.ts";
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
  handleStore,
  importBooks,
  pickFolder,
  rememberedFolder,
  reopenFolder,
} from "./fs-store.ts";
import type { BookStore } from "../../server/store.ts";
import { importSource } from "../../server/import/mod.ts";
import "../../renderer/plates.js"; // registers the Paged.js plate handler
import "../../renderer/folios.js"; // registers the page-map handler

const PARSE_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MS = 600;

const clientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
let view: string | null = params.get("view"); // the Style/Publish nav row

// The library's id (library.json, minted by the service), written into the
// URL so a link from another library (their book, mode and line, meaningless
// here) goes to the plain home page. Null until known, or when the store
// couldn't say; then a link is taken as is.
let libId: string | null = null;

// Keep the address bar at the author's place (appHref) without history
// entries; debounced because Safari rate-limits replaceState.
let urlTimer = 0;
const here = () =>
  appHref({ book, edition, mode, view, line: cursorLine, lib: libId });
function syncUrl(): void {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    try {
      history.replaceState(null, "", here());
    } catch {
      // rate-limited or blocked: the URL just lags
    }
  }, 250);
}

// Publish → a Style view as a history entry, like goToStyle from Write, so
// Back returns to Publish where the author left it (installHistory).
function toStyle(next: string): void {
  clearTimeout(urlTimer);
  history.replaceState(null, "", here()); // the entry Back returns to
  view = next;
  configPanel?.open(next);
  setMode("style");
  history.pushState(null, "", here());
}
const $ = (id: string) => document.getElementById(id)!;

// Author-facing status in the toolbar: a glyph + a short phrase, so it clears
// the mode switch; the detail goes in the tooltip. "Saved" says how long ago.
type StatusKind =
  | "connecting"
  | "saved"
  | "saving"
  | "error"
  | "offline"
  | "failed";
const STATUS_TEXT: Record<StatusKind, string> = {
  connecting: "Connecting…",
  saved: "Saved",
  saving: "Saving…",
  error: "Not saved",
  offline: "Disconnected",
  failed: "Couldn't load", // the app never got going; the title says why
};
let lastSaved: Date | null = null; // when a manuscript or metadata save last landed
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(then: Date): string {
  const s = Math.round((Date.now() - then.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return rtf.format(-s, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86400), "day");
}

function setStatus(kind: StatusKind, detail?: string): void {
  const el = $("status");
  el.textContent = kind === "saved" && lastSaved
    ? `Saved ${ago(lastSaved)}`
    : STATUS_TEXT[kind];
  el.dataset.kind = kind;
  el.title = kind === "saved" && lastSaved
    ? `Saved at ${lastSaved.toLocaleTimeString()}`
    : detail ?? "";
}
setInterval(() => {
  if ($("status").dataset.kind === "saved") setStatus("saved");
}, 1000);

// Short, readable tail of an error for the footer; full text stays in the title.
function brief(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 80);
}

let editor: EditorView;
let backend: Backend; // the dev server, or the service in-page over a folder
let book: string;
let edition: string | null = null; // null = the unnamed edition (metadata.json)
let parseTimer = 0;
let saveTimer = 0;
let saveInFlight = false;
let queuedSaveText: string | null = null;
let dirty = false; // local edits newer than the last completed save
let remoteFetchGen = 0;
let renaming: Promise<unknown> = Promise.resolve(); // this tab's edition rename
// The server version the buffer is based on; every save names it, and a save
// from a version that is no longer current is refused (409) instead of
// overwriting a change this editor never saw. Set on load and by every save.
let base: string | null = null;
// The disk text the changed-on-disk banner is offering, while it is up.
let diskOffer: { text: string; version: string } | null = null;
let metaBase: string | null = null; // the metadata version the panel shows
let metaStale = false; // metadata changed while the panel had unsaved edits
let metaFetchGen = 0;
let configPanel: ConfigPanel | null = null;
let metaSaveInFlight = false;
let metaSaveDone: Promise<void> = Promise.resolve(); // the save in flight
let queuedMetaSections: Partial<Metadata> | null = null;

function onDocChanged(text: string): void {
  dirty = true;
  setStatus("saving");
  $("preview").dataset.stale = ""; // dimmed until the render catches up
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => reparse(text), PARSE_DEBOUNCE_MS);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(text), SAVE_DEBOUNCE_MS);
}

let isNames: string[] = []; // `{is}` classes in the manuscript, from reparse

function reparse(text: string): void {
  const doc = parse(text);
  isNames = text.split("\n").flatMap((line) => {
    const t = parseSentinelLine(line);
    return t?.name === "is" && !t.closing && t.slug ? [t.slug] : [];
  });
  applyDiagnostics(editor, doc.diagnostics);
  renderImportNotes(text);
  setEditionSpans(editor, doc.onlySpans, editionToken(edition));
  const diag = $("diagnostics");
  const first = doc.diagnostics[0];
  diag.textContent = first
    ? `${doc.diagnostics.length} parse note${
      doc.diagnostics.length > 1 ? "s" : ""
    } — line ${first.line}: ${first.message}`
    : "";
  diag.title = first ? "click to jump to the first note" : "";
  diag.onclick = first ? () => scrollEditorToLine(editor, first.line) : null;
  refreshTree(doc);
}

// Page-map problems from the last render; each scrolls to its page.
function showPageProblems(problems: PageProblem[]): void {
  $("page-problems").replaceChildren(...problems.map((p) => {
    const { page } = p;
    const item = document.createElement("button");
    item.textContent = formatProblem(p);
    if (page !== null) {
      item.title = "click to show the page";
      item.onclick = () =>
        $("preview").querySelector(
          `:scope > :not(.preview-stage) .pagedjs_page[data-page-number="${page}"]`,
        )?.scrollIntoView({ block: "start", behavior: "auto" });
    } else item.disabled = true;
    return item;
  }));
}

let treeLines: number[] = []; // start line of every tree node, ascending
let cursorLine = 1;

function refreshTree(doc: BmlDocument): void {
  const nodes = buildTree(doc);
  treeLines = nodes.flatMap((n) => [n.line, ...n.children.map((c) => c.line)])
    .sort((a, b) => a - b);
  renderTree($("tree"), nodes, (node) => {
    scrollEditorToLine(editor, node.line);
    scrollPreviewTo(node.anchorId, $("preview"));
  });
  highlightTreeNode(cursorLine);
}

// Follow the cursor (spec §7.3): the preview outlines the block the line is
// part of, and the footer names that block's style, a click away.
function followCursor(line: number): void {
  if (!editor) return;
  markEdited($("preview"), mode === "write" ? line : null);
  const keys = styleKeysAt(editor.state.doc.toString().split("\n"), line);
  const cat = styleCatalog();
  const entry = keys.map((k) => cat.find((e) => e.key === k)).find((e) => e);
  const btn = $("style-here") as HTMLButtonElement;
  btn.hidden = !entry;
  if (!entry) return;
  btn.lastElementChild!.textContent = entry.label === "Everything"
    ? entry.group
    : `${entry.group} · ${entry.label}`;
  btn.onclick = () => goToStyle(entry.key);
}

// Follow the cursor: the node whose block contains the cursor line is current.
function highlightTreeNode(line: number): void {
  cursorLine = line;
  syncUrl();
  followCursor(line);
  let best = 0;
  for (const l of treeLines) if (l <= line) best = l;
  const tree = $("tree");
  tree.querySelector("[aria-current]")?.removeAttribute("aria-current");
  tree.querySelector(`[data-line="${best}"]`)?.setAttribute(
    "aria-current",
    "true",
  );
}

const fetchEditions = (name: string): Promise<EditionInfo[]> =>
  backend.editions(name);

// The crumb: Book / Edition, then what sets the edition apart — its page size.
function setCrumb(editions: EditionInfo[]): void {
  const cur = editions.find((e) => e.slug === edition);
  const name = cur ? editionLabel(cur) : "";
  $("book-name").textContent = titleCase(book);
  $("edition-name").textContent = name;
  document.title = `Wynkyn — ${book} · ${name}`;
}
function setCrumbSize(size: string | undefined): void {
  $("edition-size").textContent = size ? prettySize(size) : "";
}

// The switcher: books (with search) on the left, the selected book's editions
// on the right. Every open re-fetches, so summaries follow page-size edits.
let books: string[] = [];
let selBook = ""; // the book whose editions the right side lists
let selEditions: EditionInfo[] = [];
let selGen = 0;
const switcher = () => $("switcher") as HTMLDialogElement;
const bookSearch = () => $("book-search") as HTMLInputElement;
const newForm = () => $("edition-new-form") as HTMLFormElement;

function bookHits(): string[] {
  const q = bookSearch().value.trim().toLowerCase();
  return books.filter((b) =>
    !q || b.includes(q) || titleCase(b).toLowerCase().includes(q)
  );
}

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
  renderBooks();
  hideNewForm();
  const gen = ++selGen;
  try {
    const eds = await fetchEditions(b);
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

// Full navigation, not in-place teardown: clean WS/editor/tree state. A line
// rides along in the hash for main() to jump the editor to.
function openEdition(b: string, slug: string | null, line?: number): void {
  if (b === book && slug === edition) {
    switcher().close();
    if (line) {
      setMode("write");
      scrollEditorToLine(editor, line);
    }
    return;
  }
  location.href = editionHref(b, slug) + (line ? `#line=${line}` : "");
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
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#check");
      ck.append(use);
    }
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = editionLabel(e);
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
      input.value = editionLabel(e);
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
            `Delete the ${
              editionLabel(e)
            } edition? The manuscript is untouched.`,
          )
        ) return;
        await backend.deleteEdition(selBook, slug);
        await deleteCachedRender(cacheId(selBook, slug));
        if (selBook === book && slug === edition) {
          location.href = editionHref(book, null);
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
      const done = backend.renameEdition(selBook, e.slug, next)
        .then(() => selBook === book ? rebaseAfterRename() : undefined);
      renaming = done.catch(() => {});
      await done;
      await deleteCachedRender(cacheId(selBook, e.slug));
      if (selBook === book && e.slug === edition) {
        location.href = editionHref(book, next);
        return;
      }
    }
  }
  await selectBook(selBook);
}

async function jumpToPassages(slug: string | null): Promise<void> {
  const text = selBook === book
    ? editor.state.doc.toString()
    : (await fetchManuscript(selBook)).text;
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

function installSwitcher(): void {
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
      dialog.style.left = `${$("crumb").getBoundingClientRect().left}px`;
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
  // The selected book's folder as a zip: the way out of browser storage.
  const download = $("book-download");
  download.hidden = !backend.store;
  download.onclick = async () => {
    try {
      const zip = await zipBook(backend.store!, selBook);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([zip], { type: "application/zip" }),
      );
      a.download = `${selBook}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      $("book-err").textContent = brief(err);
    }
  };
  // Where the library lives, and the way to a different one: forget the
  // choice and pick again on the next load.
  const note = $("library-note");
  const pref = localStorage.getItem("library");
  note.hidden = backend.kind !== "local";
  if (pref === "browser") {
    note.textContent = "Kept in this browser only. Browsers clear site " +
      "storage without asking, so download a book to keep it.";
  } else if (pref === "folder") {
    note.textContent = "Loading…";
    rememberedFolder().then((dir) => {
      note.textContent = `Books in the “${dir?.name}” folder on this device.`;
    });
  }
  $("library-open").onclick = () => {
    localStorage.removeItem("library");
    location.href = "/";
  };

  $("edition-new").onclick = () => {
    from.replaceChildren(
      ...selEditions.map((e) =>
        new Option(editionLabel(e), e.slug ?? "default")
      ),
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
      location.href = editionHref(selBook, slug);
    } catch (err) {
      formErr.textContent = brief(err);
    }
  };
}

// Never let two save requests be in flight at once (Task 4 fix): a second
// save while one is pending would race the first over the network, and
// whichever POST body the server sees last wins — an older in-flight save
// could clobber a newer one on disk. Instead, queue the latest text and
// fire it immediately when the in-flight request finishes.
function save(text: string): void {
  if (saveInFlight) {
    queuedSaveText = text; // supersede any earlier queued text — only the latest matters
    return;
  }
  setSaveInFlight(true);
  doSave(text);
}

// The banner's choices wait for a save in flight to settle: Reload under an
// accepted save would show text the disk no longer has.
function setSaveInFlight(on: boolean): void {
  saveInFlight = on;
  for (const id of ["disk-reload", "disk-keep"]) {
    ($(id) as HTMLButtonElement).disabled = on;
  }
}

async function doSave(text: string): Promise<void> {
  try {
    await renaming; // a rename's token rewrite moves `base`
    const ok = await backend.saveManuscript(book, { text, clientId, base });
    if ("conflict" in ok) {
      // Equal: Reload or Keep mine already settled on this version, and a
      // Keep mine save may be queued behind this one — leave it.
      if (ok.version !== base) {
        queuedSaveText = null; // based on the same stale version
        showDiskBanner(ok);
        setStatus("error", "something else touched the manuscript");
      }
      return;
    }
    base = ok.version;
    // The server rewrote the save (a renamed edition's token): take its text,
    // unless the author has typed past what was sent.
    if (ok.text !== undefined && editor.state.doc.toString() === text) {
      replaceBuffer(editor, ok.text);
      reparse(ok.text);
    }
    if (diskOffer?.version === base) hideDiskBanner(); // it was our own save
    if (editor.state.doc.toString() === (ok.text ?? text)) {
      dirty = false;
      lastSaved = new Date();
      if (!metaSaveInFlight && !configPanel?.isDirty()) setStatus("saved");
    }
  } catch (err) {
    setStatus("error", brief(err));
  } finally {
    setSaveInFlight(false);
    if (queuedSaveText !== null) {
      const next = queuedSaveText;
      queuedSaveText = null;
      // fire-and-forget: intentional non-blocking dispatch, not a missing await —
      // doSave's own finally will run again when this one settles.
      setSaveInFlight(true);
      doSave(next); // catch-up save, no debounce — the debounce already happened once
    }
  }
}

function saveMetadataSections(sections: Partial<Metadata>): void {
  if ("page" in sections) setCrumbSize(sections.page?.size);
  if (metaSaveInFlight) {
    queuedMetaSections = { ...queuedMetaSections, ...sections };
    return;
  }
  metaSaveInFlight = true;
  metaSaveDone = doMetadataSave(sections);
}

async function doMetadataSave(sections: Partial<Metadata>): Promise<void> {
  try {
    metaBase = (await backend.saveMetadata(book, edition, sections)).version;
    lastSaved = new Date();
    if (
      !dirty && !saveInFlight && !queuedMetaSections && !configPanel?.isDirty()
    ) {
      setStatus("saved");
    }
  } catch (err) {
    setStatus("error", `config: ${brief(err)}`);
  } finally {
    metaSaveInFlight = false;
    if (queuedMetaSections !== null) {
      const next = queuedMetaSections;
      queuedMetaSections = null;
      // fire-and-forget: same intentional non-blocking dispatch as doSave.
      metaSaveInFlight = true;
      metaSaveDone = doMetadataSave(next);
    } else if (metaStale) refreshConfigFromRemote(); // no-op while still dirty
  }
}

const fetchMetadata = (): Promise<
  { metadata: Metadata; version: string | null }
> => backend.metadata(book, edition);

let metadata: Metadata | null = null; // last fetched; the style catalog reads `is` from it
const styleCatalog = () => {
  const m = metadata ?? {};
  addIsNames(m, isNames);
  return catalogFor(m);
};

// The Publish tab's e-book export, run once every style save has landed.
async function exportEpub(): Promise<EpubResult> {
  while (metaSaveInFlight) await metaSaveDone;
  try {
    return await backend.exportEpub(book, edition);
  } catch (err) {
    return { error: brief(err) };
  }
}

// Built the first time Style or Publish opens; a failed load is retried next time.
let panelLoad: Promise<ConfigPanel | null> | null = null;
function ensureConfigPanel(): Promise<ConfigPanel | null> {
  return panelLoad ??= (async () => {
    try {
      ({ metadata, version: metaBase } = await fetchMetadata());
      return configPanel = createConfigPanel({
        overlay: $("config-overlay"),
        nav: $("style-nav"),
        sheetView: $("sheet-view"),
        metadata,
        saveSections: saveMetadataSections,
        onEdit: () => {
          setStatus("saving");
          $("preview").dataset.stale = "";
        },
        preview: previewLink($("preview"), styleCatalog),
        isNames: () => isNames,
        exportEpub,
        toStyle,
        view,
        onRoute: (id) => {
          view = id;
          syncUrl();
        },
      });
    } catch (err) {
      panelLoad = null;
      setStatus("error", brief(err)); // e.g. 409 corrupt metadata.json — fix on disk
      return null;
    }
  })();
}

const MODES: Mode[] = ["write", "style", "publish"];
let mode: Mode = "write";

// The mode decides all three columns (spec §7.1): Write = outline | editor |
// pages, Style = style nav | style part | pages, Publish = publish nav |
// print setup and exports | sheet view. Persisted across reloads.
function setMode(next: Mode): void {
  mode = next;
  document.documentElement.dataset.mode = next;
  for (const b of $("modes").querySelectorAll<HTMLElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === next));
  }
  try {
    localStorage.setItem("mode", next);
  } catch {
    // storage blocked: the mode just won't survive a reload
  }
  syncUrl();
  followCursor(cursorLine);
  if (next === "write") return;
  ensureConfigPanel().then((panel) => {
    if (mode !== "write") panel?.setMode(mode); // the latest, if it changed meanwhile
  });
}

// Preview click → Style on that element (spec §7.4).
async function pickStyle(key: string): Promise<void> {
  setMode("style");
  (await ensureConfigPanel())?.selectStyle(key);
}

// The footer's Go to style: unlike a preview click, it leaves a history entry,
// so Back returns to Write at the line the writer left (installHistory).
async function goToStyle(key: string): Promise<void> {
  clearTimeout(urlTimer);
  const here = { book, edition, view, line: cursorLine, lib: libId };
  history.replaceState(null, "", appHref({ ...here, mode: "write" }));
  await pickStyle(key);
  history.pushState(null, "", appHref({ ...here, view, mode: "style" }));
}

// Back and Forward between the entries goToStyle and toStyle make: the URL's
// mode, its Style/Publish view, and in Write its line.
function installHistory(): void {
  addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search);
    const m = MODES.find((m) => m === p.get("mode")) ?? "write";
    view = p.get("view");
    setMode(m);
    if (m !== "write" && view) configPanel?.open(view);
    const line = lineFromHash(location.hash);
    if (m === "write" && line !== null) scrollEditorToLine(editor, line);
  });
}

const fetchManuscript = (
  name: string,
): Promise<{ text: string; version: string }> => backend.manuscript(name);

// Without a server the app needs a folder: the author's own books/ (the File
// System Access API, Chromium), or this browser's private storage. The choice
// is remembered; "Change library…" in the switcher forgets it. The folder buttons
// show in every browser: one without the API (Firefox, Safari, Brave until its
// flag is on) fails the click with its own error rather than hiding the
// options.
async function chooseLibrary(): Promise<BookStore> {
  const remembered = await rememberedFolder();
  const pref = localStorage.getItem("library");
  if (
    pref === "folder" && remembered && await reopenFolder(remembered, false)
  ) return handleStore(remembered);
  if (pref === "browser") return handleStore(await browserFolder());
  return new Promise((resolve) => {
    const dlg = $("library") as HTMLDialogElement;
    const err = $("lib-err");
    // Persisted storage is evicted last; the browser may still say no.
    const persist = () => navigator.storage.persist?.().catch(() => false);
    const done = (store: BookStore, kind: "folder" | "browser") => {
      localStorage.setItem("library", kind);
      if (kind === "browser") persist();
      dlg.close();
      resolve(store);
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
          done(handleStore(remembered), "folder");
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
      createBooksFolder().then((d) => done(handleStore(d), "folder"), fail);
    $("lib-pick").onclick = () =>
      pickFolder().then((d) => done(handleStore(d), "folder"), fail);
    $("lib-browser").onclick = () =>
      browserFolder().then((d) => done(handleStore(d), "browser"), fail);
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

// metadata.json written by a newer Wynkyn than this one: say so, keep going.
// Unknown keys fall through to the renderer's defaults, nothing is dropped.
function showSpecBanner(spec: string | undefined): void {
  const el = $("spec-banner");
  el.hidden = !isNewerSpec(spec);
  if (!el.hidden) {
    el.querySelector("span")!.textContent =
      `This book's metadata.json follows spec ${spec}, newer than this app's ${SPEC_VERSION}. Settings it doesn't know are kept but not shown.`;
  }
}

async function connect(): Promise<Backend> {
  if (await hasServer()) return httpBackend();
  const assets = localAssets();
  await browserNotice();
  return localBackend(await chooseLibrary(), await assets);
}

// An update built from a version the buffer isn't based on: fetch the current
// text. Its version may still be ours (a late echo, or a save acknowledged
// meanwhile). Otherwise a clean buffer just takes it; unsaved edits get the
// banner and the author decides.
async function refreshFromRemote(): Promise<void> {
  const gen = ++remoteFetchGen;
  const was = base;
  const disk = await fetchManuscript(book);
  // A save acknowledged meanwhile is newer than this read; a change after it
  // sends its own update.
  if (gen !== remoteFetchGen || base !== was || disk.version === base) return;
  if (dirty || saveInFlight) {
    showDiskBanner(disk);
    return;
  }
  replaceBuffer(editor, disk.text);
  reparse(disk.text);
  base = disk.version;
  hideDiskBanner();
}

// A rename rewrote this book's {only} tokens on disk: this tab caused that
// change, so base the buffer on it rather than 409 its own next save (the
// server rewrites the old token in that save). A clean buffer takes the text.
async function rebaseAfterRename(): Promise<void> {
  const disk = await fetchManuscript(book);
  if (!dirty && !saveInFlight) {
    replaceBuffer(editor, disk.text);
    reparse(disk.text);
  }
  base = disk.version;
  if (diskOffer?.version === base) hideDiskBanner();
}

function showDiskBanner(disk: { text: string; version: string }): void {
  diskOffer = disk;
  $("disk-banner").hidden = false;
}
function hideDiskBanner(): void {
  diskOffer = null;
  $("disk-banner").hidden = true;
}

// Reload: the disk wins — drop the unsaved edits and anything waiting to save.
function reloadFromDisk(): void {
  if (!diskOffer) return;
  const { text, version } = diskOffer;
  clearTimeout(saveTimer);
  queuedSaveText = null;
  replaceBuffer(editor, text);
  reparse(text);
  base = version;
  dirty = false;
  hideDiskBanner();
  setStatus("saved");
  editor.focus();
}

// Keep mine: base the buffer on the disk version, so the save overwrites it.
function keepMine(): void {
  if (!diskOffer) return;
  base = diskOffer.version;
  hideDiskBanner();
  clearTimeout(saveTimer);
  save(editor.state.doc.toString());
  editor.focus();
}

// metadata.json changed under this client. No banner: saves are section
// merges, so another writer's sections survive ours. Refresh an open panel
// only when it has nothing unsaved; otherwise refresh after its next save.
// ponytail: two writers on the same section, last write wins; a per-section
// version check (409 like the manuscript) if that ever bites.
async function refreshConfigFromRemote(): Promise<void> {
  if (!configPanel) return;
  if (configPanel.isDirty() || metaSaveInFlight) {
    metaStale = true;
    return;
  }
  const gen = ++metaFetchGen;
  try {
    const fresh = await fetchMetadata();
    if (gen !== metaFetchGen) return;
    if (configPanel.isDirty() || metaSaveInFlight) { // edited meanwhile
      metaStale = true;
      return;
    }
    metaStale = false;
    ({ metadata, version: metaBase } = fresh);
    configPanel.refresh(metadata);
  } catch {
    // 409/network — leave the panel as-is; the user can close and reopen.
  }
}

// Draggable gutters: each one writes a CSS var on :root that the grids of
// #panes and #footer read, persisted so widths survive a reload.
function installGutters(): void {
  const panes = $("panes");
  const root = document.documentElement; // the footer reads the widths too
  for (
    const [id, cssVar, min] of [["gutter-tree", "--w-tree", 120], [
      "gutter-editor",
      "--w-editor",
      240,
    ]] as const
  ) {
    const saved = localStorage.getItem(cssVar);
    if (saved) root.style.setProperty(cssVar, saved);
    const gutter = $(id);
    gutter.onpointerdown = (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add("dragging");
      const work = mode === "write" ? $("editor") : $("config-overlay");
      const left = (cssVar === "--w-tree" ? panes : work)
        .getBoundingClientRect().left;
      gutter.onpointermove = (m) => {
        // Leave at least 200px for whatever pane sits to the right.
        const max = panes.getBoundingClientRect().right - left - 200;
        root.style.setProperty(
          cssVar,
          `${Math.min(Math.max(m.clientX - left, min), max)}px`,
        );
      };
      gutter.onpointerup = () => {
        gutter.onpointermove = gutter.onpointerup = null;
        gutter.classList.remove("dragging");
        localStorage.setItem(cssVar, root.style.getPropertyValue(cssVar));
      };
    };
  }
}

// A side column's toolbar toggle: hides the column, persisted across reloads.
// Returns the toggle for its shortcut.
function installColumnToggle(id: string, hiddenClass: string): () => void {
  const btn = $(id);
  const panes = $("panes");
  const set = (hidden: boolean) => {
    panes.classList.toggle(hiddenClass, hidden);
    btn.setAttribute("aria-pressed", String(!hidden));
    try {
      localStorage.setItem(hiddenClass, hidden ? "1" : "");
    } catch {
      // storage blocked: the toggle just won't survive a reload
    }
  };
  let saved = false;
  try {
    saved = localStorage.getItem(hiddenClass) === "1";
  } catch {
    // as above
  }
  set(saved);
  const toggle = () => set(!panes.classList.contains(hiddenClass));
  btn.onclick = toggle;
  return toggle;
}

// Light/dark toggle; an explicit choice persists, first load follows the
// system (resolved by the inline script in index.html before first paint).
function installThemeToggle(): void {
  $("theme-toggle").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark"
      ? "light"
      : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  };
}

// The text view (the bar atop the editor): the editor's font and size and Hide markup, a per-reader
// preference kept in localStorage, not the book.
const TEXT_FONTS: Record<string, string> = {
  serif: "ui-serif, Georgia, serif",
  sans: "system-ui, sans-serif",
  mono: "var(--mono)",
};
function installTextView(): void {
  let prefs = { font: "serif", size: 16, hide: false };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem("text-view")!) };
  } catch {
    // none saved, or storage blocked: the defaults
  }
  const ed = $("editor");
  const size = $("tv-size") as HTMLInputElement;
  const hide = $("tv-hide") as HTMLInputElement;
  const fonts = [
    ...$("text-view").querySelectorAll<HTMLElement>("[data-font]"),
  ];
  const apply = () => {
    ed.style.setProperty("--ed-font", TEXT_FONTS[prefs.font] ?? null);
    ed.style.setProperty("--ed-fs", `${prefs.size}px`);
    for (const b of fonts) {
      b.setAttribute("aria-checked", String(b.dataset.font === prefs.font));
    }
    size.value = String(prefs.size);
    size.nextElementSibling!.textContent = `${prefs.size}px`;
    hide.checked = prefs.hide;
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
  hide.onchange = () => {
    prefs.hide = hide.checked;
    apply();
  };
  apply();
}

const MOD = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
// Keyboard chords. Snippet chords insert via insertSnippet; the rest are UI.
const SNIPPET_KEYS: Record<string, string> = {
  em: "Mod-E",
  chapter: "Mod-Shift-C",
  heading: "Mod-Shift-H",
  footnote: "Mod-Shift-F",
  quote: "Mod-Shift-Q",
  break: "Mod-Shift-B",
};
function chordLabel(chord: string): string {
  return chord.replace("Mod-", MOD).replace("Shift-", "⇧");
}
function chordOf(e: KeyboardEvent): string | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  return `Mod-${e.shiftKey ? "Shift-" : ""}${
    e.key.length === 1 ? e.key.toUpperCase() : e.key
  }`;
}
function installShortcuts(
  toggleContents: () => void,
  togglePages: () => void,
): void {
  const bySnippet = new Map(
    SNIPPETS.filter((s) => SNIPPET_KEYS[s.label]).map((
      s,
    ) => [SNIPPET_KEYS[s.label], s]),
  );
  document.addEventListener("keydown", (e) => {
    const chord = chordOf(e);
    if (!chord) return;
    const snippet = bySnippet.get(chord);
    const m = MODES[Number(chord.slice(4)) - 1]; // Mod-1..3
    if (snippet && mode === "write") {
      insertSnippet(editor, snippet);
    } else if (m) setMode(m);
    else if (chord === "Mod-,") setMode("style");
    else if (chord === "Mod-\\") toggleContents();
    else if (chord === "Mod-.") togglePages();
    else return;
    e.preventDefault();
  }, true);
  MODES.forEach((m, i) => {
    $("modes").querySelector(`[data-mode="${m}"]`)!.setAttribute(
      "title",
      `${m[0]!.toUpperCase()}${m.slice(1)} (${chordLabel(`Mod-${i + 1}`)})`,
    );
  });
  $("tree-toggle").title += ` (${chordLabel("Mod-\\")})`;
  $("pages-toggle").title += ` (${chordLabel("Mod-.")})`;
}

// ---- Create a new manuscript (spec §7.9) ------------------------------------
// Import a file, or start blank; both ask for a title, then open the book.
// `cancelable` is false for an empty library; there Back returns to the
// Welcome (no server only: with one, the library is the server's folder).
function createManuscript(cancelable: boolean): void {
  const dlg = $("create") as HTMLDialogElement;
  const err = $("create-err");
  err.textContent = "";
  $("create-sub").textContent = cancelable
    ? "Add another book to this library."
    : "Your library is empty. How do you want to begin?";
  const cancel = $("create-cancel");
  cancel.hidden = !cancelable;
  cancel.onclick = () => dlg.close();
  const back = $("create-back");
  back.hidden = cancelable || backend.kind !== "local";
  back.onclick = () => {
    dlg.close();
    localStorage.removeItem("library");
    main();
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
    try {
      err.textContent = "Reading…";
      const r = importSource(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
      );
      err.textContent = "";
      dlg.close();
      const got = await askTitle(
        r.title,
        `${file.name} · ${sizeLabel(file.size)}`,
        "Import",
      );
      if (!got) return createManuscript(cancelable);
      await backend.importBook(got.slug, r);
      location.href = editionHref(got.slug, null);
    } catch (e) {
      err.textContent = brief(e);
      if (!dlg.open) dlg.showModal();
    }
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
      const books = await importBooks(backend.store!, dir.files);
      if (!books.length) {
        err.textContent =
          "No book found: a book is a folder with a manuscript.md.";
        return;
      }
      location.href = editionHref(books[0]!, null);
    } catch (e) {
      err.textContent = brief(e);
    }
  };
  $("create-blank").onclick = async () => {
    dlg.close();
    try {
      const got = await askTitle("", null, "Create book");
      if (!got) return createManuscript(cancelable);
      await backend.createBook(got.slug, got.title);
      location.href = editionHref(got.slug, null);
    } catch (e) {
      err.textContent = brief(e);
      dlg.showModal();
    }
  };
  dlg.showModal();
}

const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The title dialog: the title and its slug, or null for Back. */
function askTitle(
  title: string,
  source: string | null,
  cta: string,
): Promise<{ slug: string; title: string } | null> {
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
  return new Promise((resolve) => {
    const finish = (v: { slug: string; title: string } | null) => {
      dlg.close();
      resolve(v);
    };
    $("title-back").onclick = () => finish(null);
    ($("title-form") as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      const slug = slugify(input.value) || "untitled";
      if (books.includes(slug)) {
        err.textContent = `“${slug}” is taken; pick another title.`;
        return;
      }
      finish({ slug, title: input.value });
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

// ---- Import notes (spec §7.9): the `%% check:` lines, listed in the footer --
function renderImportNotes(text: string): void {
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

async function main(): Promise<void> {
  backend = await connect();
  [books, libId] = await Promise.all([
    backend.listBooks(),
    backend.libraryId().catch(() => null),
  ]);
  const lib = params.get("lib");
  if (lib && libId && lib !== libId) {
    location.replace(location.pathname); // someone else's place: start at home
    return;
  }
  if (!books.length) {
    // An empty library: the first book is the only thing to do.
    createManuscript(false);
    return;
  }
  const requested = params.get("book");
  book = requested && books.includes(requested) ? requested : books[0]!;

  // A failed editions fetch (old server still running, network blip) must not
  // keep the whole app from booting — fall back to a single default edition.
  let editions: EditionInfo[] = [{
    slug: null,
    name: "Standard",
    summary: "",
    passages: 0,
  }];
  try {
    editions = await fetchEditions(book);
  } catch (err) {
    setStatus("error", `editions: ${brief(err)} — restart the dev server?`);
  }
  const wanted = params.get("edition");
  edition = wanted && editions.some((e) => e.slug === wanted) ? wanted : null;
  setCrumb(editions);
  installSwitcher();
  fetchMetadata().then((m) => {
    setCrumbSize(m.metadata.page?.size);
    showSpecBanner(m.metadata.spec);
  }, () => {
    // no size in the crumb; the Style panel reports the load error
  });

  const { text, version } = await fetchManuscript(book);
  base = version;
  editor = createEditor({
    parent: $("editor"),
    text,
    onDocChanged,
    onCursorLine: highlightTreeNode,
  });
  reparse(text);
  installTextView();
  $("disk-reload").onclick = reloadFromDisk;
  $("disk-keep").onclick = keepMine;
  installShortcuts(
    installColumnToggle("tree-toggle", "tree-hidden"),
    installColumnToggle("pages-toggle", "pages-hidden"),
  );
  $("modes").onclick = (e) => {
    const m = (e.target as Element).closest<HTMLElement>("[data-mode]")?.dataset
      .mode as Mode | undefined;
    if (m) setMode(m);
  };
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("mode");
  } catch {
    // storage blocked: start in Write
  }
  // The URL's mode wins; a bare `#line=N` (a switcher jump) opens in Write.
  const jump = lineFromHash(location.hash);
  const asked = MODES.find((m) => m === params.get("mode"));
  setMode(
    asked ?? (jump !== null ? "write" : MODES.find((m) => m === saved)) ??
      "write",
  );
  if (jump !== null) scrollEditorToLine(editor, jump);
  installGutters();
  installThemeToggle();
  installHistory();

  const previewEl = $("preview");
  new ResizeObserver(() => fitPreview(previewEl)).observe(previewEl);
  const refreshPageIndicator = installPageIndicator(
    previewEl,
    $("page-indicator"),
  );
  installPreviewClicks(previewEl, styleCatalog, {
    mode: () => mode,
    style: pickStyle,
    source: (line) => scrollEditorToLine(editor, line),
  });
  installStyleHover(previewEl, styleCatalog, () => mode);
  // Restore before opening the socket so the previous render is on screen
  // when the first update lands, instead of a blank preview.
  const key = cacheId(book, edition);
  const cached = await loadCachedRender(key);
  if (cached) {
    restoreCachedRender(cached, previewEl);
    refreshPageIndicator();
    followCursor(cursorLine);
  }
  const onClose = () => {
    // `deno task dev` restarts the server when app code changes; follow it
    // back with a fresh page, unless that would drop an unsaved edit.
    setStatus("offline", "Reconnecting…");
    const retry = setInterval(async () => {
      const up = await fetch("/").then((r) => r.ok, () => false);
      if (!up) return;
      clearInterval(retry);
      if (
        dirty || saveInFlight || metaSaveInFlight || configPanel?.isDirty()
      ) setStatus("offline", "Server restarted — reload to reconnect");
      else location.reload();
    }, 500);
  };
  const onMessage = (msg: ServerMessage) => {
    if (msg.type === "error") {
      if (msg.save === "metadata") { // accepted, then the write failed
        setStatus("error", `config not saved — ${brief(msg.message)}`);
      } else setStatus("error", `build: ${brief(msg.message)}`);
      return;
    }
    if (
      !dirty && !saveInFlight && !metaSaveInFlight && !configPanel?.isDirty() &&
      !diskOffer
    ) setStatus("saved");
    renderPreview(msg, previewEl, key).then((problems) => {
      delete previewEl.dataset.stale;
      showPageProblems(problems);
      refreshPageIndicator();
      configPanel?.pagesChanged();
      followCursor(cursorLine);
    }, (err) => {
      // The old pages stay up; their problems no longer describe this book.
      setStatus("error", `preview: ${brief(err)}`);
      showPageProblems([{ page: null, message: `preview failed: ${err}` }]);
    });
    // Versions this client already reflects need nothing (spec §6).
    if (msg.manuscriptVersion !== base) refreshFromRemote();
    if (msg.metadataVersion !== metaBase) refreshConfigFromRemote();
  };
  backend.subscribe(book, edition, clientId, onMessage, onClose);
}

// A boot that throws must say so, not sit on "Connecting…" for good.
main().catch((err) => setStatus("failed", String(err)));
