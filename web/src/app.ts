// web/src/app.ts — client orchestrator: book selection, editor, WebSocket, panes.
import { parse } from "../../parser/parser.ts";
import type { EditorView } from "@codemirror/view";
import type { BmlDocument } from "../../parser/types.ts";
import {
  addIsNames,
  catalogFor,
  type ExportRequest,
  type ExportResult,
} from "./style-catalog.ts";
import { parseSentinelLine } from "../../parser/sentinel.ts";
import {
  fitPreview,
  installPageIndicator,
  installPreviewClicks,
  installStyleHover,
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
} from "./editor.ts";
import { SNIPPETS } from "./snippets.ts";
import { insertSnippet } from "./editor-insert.ts";
import { buildTree } from "./tree-data.ts";
import { renderTree } from "./tree-view.ts";
import { type ConfigPanel, createConfigPanel } from "./config-panel.ts";
import type { Metadata } from "../../metadata/types.ts";
import {
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
import "../../renderer/plates.js"; // registers the Paged.js plate handler
import "../../renderer/folios.js"; // registers the page-map handler

const PARSE_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MS = 600;

const clientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

// Author-facing status: a glyph + a plain phrase; the raw error goes in the
// tooltip rather than the footer.
type StatusKind = "connecting" | "saved" | "saving" | "error" | "offline";
const STATUS_TEXT: Record<StatusKind, string> = {
  connecting: "Connecting…",
  saved: "Saved",
  saving: "Saving…",
  error: "Not saved",
  offline: "Disconnected — restart the server and reload",
};
function setStatus(kind: StatusKind, detail?: string): void {
  const el = $("status");
  el.textContent = detail && kind === "error"
    ? `${STATUS_TEXT[kind]} — ${detail}`
    : STATUS_TEXT[kind];
  el.dataset.kind = kind;
  el.title = detail ?? "";
}

// Short, readable tail of an error for the footer; full text stays in the title.
function brief(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 80);
}

let editor: EditorView;
let book: string;
let edition: string | null = null; // null = the unnamed edition (metadata.json)

function metadataUrl(): string {
  const b = encodeURIComponent(book);
  return edition === null
    ? `/api/books/${b}/metadata`
    : `/api/books/${b}/editions/${encodeURIComponent(edition)}/metadata`;
}
let parseTimer = 0;
let saveTimer = 0;
let saveInFlight = false;
let queuedSaveText: string | null = null;
let dirty = false; // local edits newer than the last completed save
let remoteFetchGen = 0;
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

// Follow the cursor: the node whose block contains the cursor line is current.
function highlightTreeNode(line: number): void {
  cursorLine = line;
  let best = 0;
  for (const l of treeLines) if (l <= line) best = l;
  const tree = $("tree");
  tree.querySelector("[aria-current]")?.removeAttribute("aria-current");
  tree.querySelector(`[data-line="${best}"]`)?.setAttribute(
    "aria-current",
    "true",
  );
}

async function api(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
}

const post = (url: string, body: unknown) =>
  api(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function fetchEditions(name: string): Promise<EditionInfo[]> {
  const res = await fetch(`/api/books/${encodeURIComponent(name)}/editions`);
  if (!res.ok) throw new Error(`${res.status}`);
  return ((await res.json()) as { editions: EditionInfo[] }).editions;
}

// The crumb: Book / Edition, then what sets the edition apart — its page size.
function setCrumb(editions: EditionInfo[]): void {
  const cur = editions.find((e) => e.slug === edition);
  const name = cur ? editionLabel(cur) : "";
  $("book-name").textContent = titleCase(book);
  $("edition-name").textContent = name;
  document.title = `Book Editor — ${book} · ${name}`;
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
  const base = `/api/books/${encodeURIComponent(selBook)}/editions`;
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
        await api(`${base}/${encodeURIComponent(slug)}`, { method: "DELETE" });
        await deleteCachedRender(cacheId(selBook, slug));
        if (selBook === book && slug === edition) {
          location.search = editionHref(book, null);
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
  const base = `/api/books/${encodeURIComponent(selBook)}/editions`;
  if (e.slug === null) {
    await post(`${base}/default/rename`, { name: value });
  } else {
    const next = slugify(value);
    if (!next) throw new Error("the name needs a letter or digit");
    if (next !== e.slug) {
      await post(`${base}/${encodeURIComponent(e.slug)}/rename`, {
        slug: next,
      });
      await deleteCachedRender(cacheId(selBook, e.slug));
      if (selBook === book && e.slug === edition) {
        location.search = editionHref(book, next);
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
      await post(`/api/books/${encodeURIComponent(selBook)}/editions`, {
        slug,
        from: from.value,
      });
      location.search = editionHref(selBook, slug);
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
  saveInFlight = true;
  doSave(text);
}

async function doSave(text: string): Promise<void> {
  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(book)}/manuscript`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, clientId, base }),
      },
    );
    if (res.status === 409) {
      const disk = await res.json() as { text: string; version: string };
      // Equal: Reload or Keep mine already settled on this version, and a
      // Keep mine save may be queued behind this one — leave it.
      if (disk.version !== base) {
        queuedSaveText = null; // based on the same stale version
        showDiskBanner(disk);
        setStatus("error", "manuscript.md changed on disk");
      }
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    const ok = await res.json() as { version: string; text?: string };
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
      setStatus("saved");
    }
  } catch (err) {
    setStatus("error", brief(err));
  } finally {
    saveInFlight = false;
    if (queuedSaveText !== null) {
      const next = queuedSaveText;
      queuedSaveText = null;
      // fire-and-forget: intentional non-blocking dispatch, not a missing await —
      // doSave's own finally will run again when this one settles.
      saveInFlight = true;
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
    const res = await fetch(metadataUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections, clientId }),
    });
    if (!res.ok) throw new Error(await res.text());
    metaBase = ((await res.json()) as { version: string }).version;
    configPanel?.markSaved(true);
  } catch (err) {
    configPanel?.markSaved(false, brief(err));
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

async function fetchMetadata(): Promise<
  { metadata: Metadata; version: string | null }
> {
  const res = await fetch(metadataUrl());
  if (!res.ok) {
    throw new Error(`metadata load failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as { metadata: Metadata; version: string | null };
}

let metadata: Metadata | null = null; // last fetched; the style catalog reads `is` from it
const styleCatalog = () => {
  const m = metadata ?? {};
  addIsNames(m, isNames);
  return catalogFor(m);
};

// The Print tab's export, run once every style save has reached the server.
async function exportPrint(req: ExportRequest): Promise<ExportResult> {
  while (metaSaveInFlight) await metaSaveDone;
  const q = edition === null ? "" : `?edition=${encodeURIComponent(edition)}`;
  const base = `/api/books/${encodeURIComponent(book)}/export`;
  try {
    const res = await fetch(base + q, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (
      res.status === 409 && res.headers.get("content-type")?.includes("json")
    ) {
      const { problems } = await res.json() as { problems: string[] };
      return { problems, files: [] };
    }
    if (!res.ok) return { error: await res.text(), problems: [], files: [] };
    const r = await res.json() as {
      summary: string;
      files: string[];
      problems: string[];
    };
    // A fresh query per export, so the viewer never shows a cached PDF.
    const v = `${q ? `${q}&` : "?"}v=${Date.now()}`;
    return {
      ...r,
      files: r.files.map((name) => ({
        name,
        url: `${base}/${encodeURIComponent(name)}${v}`,
      })),
    };
  } catch (err) {
    return { error: brief(err), problems: [], files: [] };
  }
}

// Built the first time Style or Print opens; a failed load is retried next time.
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
        preview: previewLink($("preview"), styleCatalog),
        isNames: () => isNames,
        exportPrint,
      });
    } catch (err) {
      panelLoad = null;
      setStatus("error", brief(err)); // e.g. 409 corrupt metadata.json — fix on disk
      return null;
    }
  })();
}

const MODES: Mode[] = ["write", "style", "print"];
let mode: Mode = "write";

// The mode decides all three columns (spec §7.1): Write = outline | editor |
// pages, Style = style nav | style part | pages, Print = print nav | print
// settings | sheet view. Persisted across reloads.
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

async function fetchManuscript(
  name: string,
): Promise<{ text: string; version: string }> {
  const res = await fetch(`/api/books/${encodeURIComponent(name)}/manuscript`);
  if (!res.ok) throw new Error(`manuscript load failed: ${res.status}`);
  return await res.json() as { text: string; version: string };
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

// Draggable gutters: each one writes a CSS var on #panes that the grid
// template reads, persisted so widths survive a reload.
function installGutters(): void {
  const panes = $("panes");
  for (
    const [id, cssVar, min] of [["gutter-tree", "--w-tree", 120], [
      "gutter-editor",
      "--w-editor",
      240,
    ]] as const
  ) {
    const saved = localStorage.getItem(cssVar);
    if (saved) panes.style.setProperty(cssVar, saved);
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
        panes.style.setProperty(
          cssVar,
          `${Math.min(Math.max(m.clientX - left, min), max)}px`,
        );
      };
      gutter.onpointerup = () => {
        gutter.onpointermove = gutter.onpointerup = null;
        gutter.classList.remove("dragging");
        localStorage.setItem(cssVar, panes.style.getPropertyValue(cssVar));
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

async function main(): Promise<void> {
  const res = await fetch("/api/books");
  books = ((await res.json()) as { books: string[] }).books;
  if (!books.length) {
    setStatus("error", "no books found in books/");
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
  fetchMetadata().then((m) => setCrumbSize(m.metadata.page?.size), () => {
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
  // A switcher jump to an edition's first passage (`#line=N`) opens in Write.
  const jump = lineFromHash(location.hash);
  if (jump !== null) history.replaceState(null, "", location.search);
  setMode(jump !== null ? "write" : MODES.find((m) => m === saved) ?? "write");
  if (jump !== null) scrollEditorToLine(editor, jump);
  installGutters();
  installThemeToggle();

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
  }
  const ws = new WebSocket(
    `ws://${location.host}/ws${editionHref(book, edition)}&client=${clientId}`,
  );
  ws.onopen = () => setStatus("saved");
  ws.onclose = () => setStatus("offline");
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMessage;
    if (msg.type === "error") {
      setStatus("error", `build: ${brief(msg.message)}`);
      return;
    }
    if (!dirty && !saveInFlight && !diskOffer) setStatus("saved");
    renderPreview(msg, previewEl, key).then((problems) => {
      showPageProblems(problems);
      refreshPageIndicator();
      configPanel?.pagesChanged();
    }, (err) => {
      // The old pages stay up; their problems no longer describe this book.
      setStatus("error", `preview: ${brief(err)}`);
      showPageProblems([{ page: null, message: `preview failed: ${err}` }]);
    });
    // Versions this client already reflects need nothing (spec §6).
    if (msg.manuscriptVersion !== base) refreshFromRemote();
    if (msg.metadataVersion !== metaBase) refreshConfigFromRemote();
  };
}

main();
