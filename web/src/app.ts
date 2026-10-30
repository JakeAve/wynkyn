// web/src/app.ts — client orchestrator: book selection, editor, WebSocket, panes.
import { parse } from "../../parser/parser.ts";
import type { EditorView } from "@codemirror/view";
import type { BmlDocument } from "../../parser/types.ts";
import {
  catalogFor,
  type EpubResult,
  type StyleStep,
  syncIsNames,
} from "./style-catalog.ts";
import { parseSentinelLine } from "../../parser/sentinel.ts";
import {
  type CachedBook,
  clearPreview,
  fitPreview,
  installPageIndicator,
  installPreviewClicks,
  installStyleHover,
  markEdited,
  type Mode,
  pageMap,
  pageTurns,
  previewLink,
  renderPreview,
  restoreCachedRender,
  scrollPreviewTo,
  setPaperStock,
  type UpdateMessage,
} from "./preview.ts";
import type { ServerMessage } from "../../server/pipeline.ts";
import { cacheId, loadCachedRender, untokenImages } from "./preview-cache.ts";
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
import { styleKeysAt } from "./bml-language.ts";
import { chapterAt, wordCount } from "./prose-model.ts";
import { setPageTurns } from "./prose.ts";
import { type ImageHost, pickImageFile } from "./editor-images.ts";
import type { ImageFile } from "../../server/images.ts";
import { buildTree } from "./tree-data.ts";
import { renderTree } from "./tree-view.ts";
import { type ConfigPanel, createConfigPanel } from "./config-panel.ts";
import type { Metadata } from "../../metadata/types.ts";
import { isNewerSpec, SPEC_VERSION } from "../../metadata/upgrade.ts";
import { appHref, type EditionInfo, lineFromHash } from "./editions.ts";
import { editionToken } from "../../server/editions.ts";
import { Sync, type SyncStatus } from "./sync.ts";
import type { Backend } from "./backend.ts";
import { installSwitcher, showLibrary, type Switcher } from "./switcher.ts";
import { installCreateBook, renderImportNotes } from "./create-book.ts";
import { ThemePreview } from "./theme-preview.ts";
import { StyleUndo } from "./style-undo.ts";
import { installUndo, type Undo } from "./undo.ts";
import { installVersions, type Versions } from "./versions.ts";
import { installTextView } from "./text-view.ts";
import { installPanes } from "./panes.ts";
import { installShortcuts } from "./shortcuts.ts";
import { installPreviewZoom } from "./preview-zoom.ts";
import { installInspect } from "./inspect.ts";
import { changeLibrary, connect, lastBookKey, whereBooks } from "./library.ts";
import { chooseBook } from "./choose-book.ts";
import { $, brief, store } from "./dom.ts";
import { h } from "./panel-controls.ts";
import "../../renderer/plates.js"; // registers the Paged.js plate handler
import "../../renderer/folios.js"; // registers the page-map handler
// folios.js is a classic script (toHtml inlines it), so its helpers hang off
// this global rather than being exported.
declare const BookPageMap: {
  printDpi(img: HTMLImageElement): number | null;
};

const PARSE_DEBOUNCE_MS = 250;

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
let urlTimer: ReturnType<typeof setTimeout> | undefined;
const here = () =>
  appHref({
    book,
    edition,
    mode,
    view,
    line: cursorLine,
    lib: libId,
    history: versions?.at(),
  });
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

// A jump as a history entry, so Back returns to where the author was
// (installHistory).
function pushPlace(go: () => void): void {
  clearTimeout(urlTimer);
  history.replaceState(null, "", here()); // the entry Back returns to
  go();
  history.pushState(null, "", here());
}

// Publish → a Style view, like goToStyle from Write.
function toStyle(next: string): void {
  pushPlace(() => {
    view = next;
    configPanel?.open(next);
    setMode("style");
  });
}

// A short phrase, so it clears the mode switch; the detail goes in the
// tooltip. "Saved" draws as a muted check (the text stays for screen readers).
type StatusKind =
  | "connecting"
  | "saved"
  | "saving"
  | "error"
  | "offline"
  | "failed"
  | "connected";
const STATUS_TEXT: Record<StatusKind, string> = {
  connecting: "Connecting…",
  saved: "Saved",
  saving: "Saving…",
  error: "Not saved",
  offline: "Disconnected",
  failed: "Couldn't load", // the app never got going; the title says why
  connected: "",
};
let lastSaved: Date | null = null;

function setStatus(kind: StatusKind, detail?: string): void {
  const el = $("status");
  el.textContent = STATUS_TEXT[kind];
  el.dataset.kind = kind;
  const at = lastSaved?.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  el.title = kind !== "saved"
    ? detail ?? ""
    : at
    ? `Saved at ${at}`
    : "All changes saved";
}

// A file dropped where nothing takes it (the editor and an empty placeholder
// do) would open in the tab and lose unsaved edits. Bubbling, so it runs last.
for (const type of ["dragover", "drop"] as const) {
  addEventListener(type, (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  });
}

let imageNoteTimer: ReturnType<typeof setTimeout> | undefined;
let cursorNote = { text: "", warn: false };
function showImageNote({ text, warn }: typeof cursorNote): void {
  const el = $("image-note");
  // the filenames read as identifiers (§3.1)
  const m = text.match(/^(Added to the book's images as )(.+)/);
  el.replaceChildren(
    ...m ? [m[1]!, h("span", { class: "hivis" }, m[2]!)] : [text],
  );
  el.classList.toggle("warn", warn);
}
function imageNote(text: string, warn = false): void {
  showImageNote({ text, warn });
  clearTimeout(imageNoteTimer);
  imageNoteTimer = setTimeout(() => {
    imageNoteTimer = undefined;
    showImageNote(cursorNote);
  }, 6000);
}

// A plate's copy has no data-line; it keeps the figure's id, the slug.
function noteImageDpi(lines: string[], line: number): void {
  const at = (n: number) =>
    lines[n - 1]?.match(/^\{illustration:\s*([^\s|}]+)/);
  const own = at(line);
  const above = lines[line - 1]?.trim() ? at(line - 1) : null;
  const slug = (own ?? above)?.[1];
  const figLine = own ? line : line - 1;
  const img = slug
    ? [
      ...$("preview").querySelectorAll<HTMLImageElement>(
        `figure[data-line="${figLine}"] img, .plate-shell > figure#${
          CSS.escape(slug)
        } img`,
      ),
    ].find((el) => !el.closest(".preview-stage"))
    : undefined;
  const dpi = img ? BookPageMap.printDpi(img) : null;
  cursorNote = dpi === null
    ? { text: "", warn: false }
    : { text: `Prints at ${dpi} dpi here; 300 looks sharp`, warn: dpi < 200 };
  if (!imageNoteTimer) showImageNote(cursorNote);
}

// Spec §7.6: saved as exactly the slug; the rebuild shows it.
function fillPlaceholder(host: ImageHost, slug: string, file?: File): void {
  const save = (f: File) =>
    host.add(f, slug).then(
      (img) => host.note(`Added to the book's images as ${img.name}`),
      (err) =>
        host.note(err instanceof Error ? err.message : String(err), true),
    );
  if (file) save(file);
  else pickImageFile().then((picked) => picked && save(picked));
}

let editor: EditorView;
let backend: Backend; // the dev server, or the service in-page over a folder
let book: string;
let edition: string | null = null; // null = the unnamed edition (metadata.json)
let parseTimer: ReturnType<typeof setTimeout> | undefined;
let sync: Sync;
let remoteFetchGen = 0;
let diskOffer: { text: string; version: string } | null = null;
let metaStale = false; // metadata changed while the panel had unsaved edits
let metaFetchGen = 0;
let configPanel: ConfigPanel | null = null;
let books: string[] = []; // the library's, as last listed
let switcher: Switcher; // the crumb and the book/edition switcher, from main
let versions: Versions | undefined; // History, once a book is open

function onDocChanged(text: string): void {
  $("preview").dataset.stale = ""; // dimmed until the render catches up
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => reparse(text), PARSE_DEBOUNCE_MS);
  sync.editManuscript(text);
  undoUi?.refresh();
}

let isNames: string[] = []; // `{is}` classes in the manuscript, from reparse

// Words in the manuscript now, and the session's baseline: the count when
// the page opened (a book switch reloads the page), moved by every reload
// from disk, since words that arrive from outside weren't written here.
let words = 0;
let wordsAtOpen: number | null = null;

function takeDiskText(text: string): void {
  if (wordsAtOpen !== null) wordsAtOpen += wordCount(text.split("\n")) - words;
  replaceBuffer(editor, text);
  undoUi?.refresh();
  reparse(text);
}

function showStats(lines: string[], line: number): void {
  if (wordsAtOpen === null) return;
  const chapter = chapterAt(lines, line);
  const parts: (string | HTMLElement)[] = [];
  if (chapter) {
    const name = document.createElement("span");
    name.textContent = chapter.title ?? chapter.slug;
    if (chapter.title === null) name.className = "hivis";
    parts.push(name, " · ");
  }
  const added = Math.max(0, words - wordsAtOpen);
  const gain = document.createElement("span");
  gain.textContent = `+${added.toLocaleString()} this session`;
  if (added) gain.className = "gain";
  parts.push(
    `${words.toLocaleString()} ${words === 1 ? "word" : "words"} · `,
    gain,
  );
  $("write-stats").replaceChildren(...parts);
}

function reparse(text: string): void {
  const doc = parse(text);
  const lines = text.split("\n");
  words = wordCount(lines);
  wordsAtOpen ??= words;
  showStats(lines, cursorLine);
  isNames = lines.flatMap((line) => {
    const t = parseSentinelLine(line);
    return t?.name === "is" && !t.closing && t.slug ? [t.slug] : [];
  });
  configPanel?.isNamesChanged();
  applyDiagnostics(editor, doc.diagnostics);
  renderImportNotes(text, goToLine);
  setEditionSpans(editor, doc.onlySpans, editionToken(edition));
  const diag = $("diagnostics");
  const first = doc.diagnostics[0];
  diag.textContent = first
    ? `${doc.diagnostics.length} parse note${
      doc.diagnostics.length > 1 ? "s" : ""
    } — line ${first.line}: ${first.message}`
    : "";
  diag.title = first ? "click to jump to the first note" : "";
  diag.onclick = first ? () => goToLine(first.line) : null;
  refreshTree(doc);
}

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

// Spec §7.3.
function followCursor(line: number): void {
  if (!editor) return;
  markEdited($("preview"), mode === "write" && !versions?.at() ? line : null);
  const lines = editor.state.doc.toString().split("\n");
  noteImageDpi(lines, line);
  showStats(lines, line);
  const keys = styleKeysAt(lines, line);
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

let leaving = false; // the author chose to go: beforeunload asks nothing more
async function leave(href: string): Promise<boolean> {
  // No sync before a book opens (an empty library's first create).
  if (sync) {
    await sync.flush();
    if (
      sync.hasUnsaved() &&
      !confirm("Some changes aren't saved. Leave anyway?")
    ) return false;
  }
  leaving = true;
  location.href = href;
  return true;
}

// Sync's status onto the toolbar — the only way "Saved" gets there.
function showSync(s: SyncStatus): void {
  lastSaved = sync.savedAt;
  if (s.kind === "conflict") {
    setStatus("error", "something else touched the manuscript");
  } else if (s.kind === "error") setStatus("error", brief(s.detail));
  else setStatus(s.kind);
}

let metaWasBusy = false;
function syncChanged(s: SyncStatus): void {
  // The banner's choices wait for a save in flight to settle: Reload under an
  // accepted save would show text the disk no longer has.
  for (const id of ["disk-reload", "disk-keep"]) {
    ($(id) as HTMLButtonElement).disabled = sync.manuscriptBusy();
  }
  if (diskOffer?.version === sync.base) hideDiskBanner(); // it was our own save
  layoutCaughtUp(); // a save or reload landed on the pages' text
  showSync(s);
  const metaBusy = sync.metadataBusy();
  if (metaWasBusy && !metaBusy && metaStale) refreshConfigFromRemote();
  metaWasBusy = metaBusy;
}

const styleUndo = new StyleUndo();
let undoUi: Undo | undefined;

function saveMetadataSections(
  sections: Partial<Metadata>,
  record = true,
): void {
  if (record) {
    styleUndo.record(sections, view ?? "");
    undoUi?.refresh();
  }
  if ("page" in sections) {
    switcher.setCrumbSize(sections.page?.size);
    setPaperStock(sections.page?.paper);
  }
  // Saves replace whole sections, so this keeps `metadata` what the panel
  // shows: its own sections, uncopied (Sync copies what it sends).
  if (metadata) metadata = { ...metadata, ...sections };
  sync.editMetadata(sections);
}

const fetchMetadata = (): Promise<
  { metadata: Metadata; version: string | null }
> => backend.metadata(book, edition);

let metadata: Metadata | null = null; // last fetched; the style catalog reads `is` from it
const styleCatalog = () => {
  const m = metadata ?? {};
  syncIsNames(m, isNames);
  return catalogFor(m);
};

async function exportEpub(): Promise<EpubResult> {
  await sync.flush();
  try {
    return await backend.exportEpub(book, edition);
  } catch (err) {
    return { error: brief(err) };
  }
}

let panelLoad: Promise<ConfigPanel | null> | null = null;
function ensureConfigPanel(): Promise<ConfigPanel | null> {
  return panelLoad ??= (async () => {
    try {
      const loaded = await fetchMetadata();
      metadata = loaded.metadata;
      sync.rebaseMetadata(loaded.version);
      styleUndo.reset(metadata);
      undoUi?.refresh();
      return configPanel = createConfigPanel({
        overlay: $("config-overlay"),
        nav: $("style-nav"),
        sheetView: $("sheet-view"),
        metadata,
        saveSections: saveMetadataSections,
        onEdit: () => $("preview").dataset.stale = "",
        preview: previewLink($("preview"), styleCatalog),
        isNames: () => isNames,
        exportEpub,
        toStyle,
        tryTheme: (slug) => void themes.try(slug),
        applyTheme: (slug) => themes.askApply(slug),
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

// A null cacheKey paints without touching the book's cached render.
let paint: (msg: UpdateMessage, cacheKey?: string | null) => void = () => {};
let restore: (cached: CachedBook | null, version?: string) => void = () => {};
// Takes a painted layout as the buffer's once the buffer reaches its text.
let layoutCaughtUp = () => {};

// An image it can't read (removed, renamed, refused) is a miss, never a
// throw: the editor starts on it.
async function loadCachedBook(): Promise<CachedBook | null> {
  const cached = await loadCachedRender(cacheId(book, edition));
  if (!cached) return null;
  const names = new Set<string>(); // the images it names, read as untokenImages does
  for (const s of cached.segments) {
    untokenImages(s.pages, (n) => (names.add(n), ""));
  }
  try {
    const urls = new Map(
      await Promise.all(
        [...names].map(async (n) =>
          [n, await backend.imageUrl(book, n)] as const
        ),
      ),
    );
    return { ...cached, imageUrl: (n) => urls.get(n) ?? "" };
  } catch {
    return null;
  }
}

// The edition's metadata with every style edit landed, so a theme goes over
// what the author sees. The held copy is current unless another writer changed
// metadata.json since (metaStale until refreshConfigFromRemote catches up).
async function settledMetadata(): Promise<Metadata> {
  await sync.flush();
  if (metadata && !metaStale) return metadata;
  return (await fetchMetadata()).metadata;
}

// Spec §7.5.
const themes = new ThemePreview({
  backend: () => backend,
  book: () => book,
  edition: () => edition,
  sync: () => sync,
  configPanel: () => configPanel,
  settledMetadata,
  setMetadata: (m) => metadata = m,
  saveSections: saveMetadataSections,
  paint: (msg, cacheKey) => paint(msg, cacheKey),
  restore: (cached, version) => restore(cached, version),
  loadCachedBook,
  leave,
  setStatus,
});

const MODES: Mode[] = ["write", "style", "publish"];
let mode: Mode = "write";

// Spec §7.1.
function setMode(next: Mode): void {
  mode = next;
  undoUi?.refresh();
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
  if (next !== "style") themes.end(); // the panel ends it on Publish too
  if (next === "write") return;
  ensureConfigPanel().then((panel) => {
    if (mode !== "write") panel?.setMode(mode); // the latest, if it changed meanwhile
  });
}

// A footer note or an Inspect row → that line in Write; the editor is hidden
// in Style and Publish, so scrolling it alone would show nothing.
function goToLine(line: number): void {
  setMode("write");
  scrollEditorToLine(editor, line);
}

// Preview click → Style on that element (spec §7.4).
async function pickStyle(key: string, path?: StyleStep[]): Promise<void> {
  setMode("style");
  (await ensureConfigPanel())?.selectStyle(key, path);
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

function installHistory(): void {
  addEventListener("popstate", () => {
    const p = new URLSearchParams(location.search);
    const m = MODES.find((m) => m === p.get("mode")) ?? "write";
    view = p.get("view");
    void versions?.follow(p.get("history"));
    setMode(m);
    if (m !== "write" && view) configPanel?.open(view);
    const line = lineFromHash(location.hash);
    if (m === "write" && line !== null) scrollEditorToLine(editor, line);
  });
}

const fetchManuscript = (
  name: string,
): Promise<{ text: string; version: string }> => backend.manuscript(name);

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

// An update built from a version the buffer isn't based on: fetch the current
// text. Its version may still be ours (a late echo, or a save acknowledged
// meanwhile). Otherwise a clean buffer just takes it; unsaved edits get the
// banner and the author decides.
async function refreshFromRemote(): Promise<void> {
  const gen = ++remoteFetchGen;
  const was = sync.base;
  const disk = await fetchManuscript(book);
  // A save acknowledged meanwhile is newer than this read; a change after it
  // sends its own update.
  if (
    gen !== remoteFetchGen || sync.base !== was || disk.version === sync.base
  ) return;
  if (sync.manuscriptDirty() || sync.manuscriptBusy()) {
    showDiskBanner(disk);
    return;
  }
  takeDiskText(disk.text);
  sync.rebase(disk.version);
  hideDiskBanner();
}

// A rename rewrote this book's {only} tokens on disk: this tab caused that
// change, so base the buffer on it rather than 409 its own next save (the
// server rewrites the old token in that save). A clean buffer takes the text.
async function rebaseAfterRename(): Promise<void> {
  const disk = await fetchManuscript(book);
  if (!sync.manuscriptDirty() && !sync.manuscriptBusy()) {
    takeDiskText(disk.text);
  }
  sync.rebase(disk.version);
  if (diskOffer?.version === sync.base) hideDiskBanner();
}

function showDiskBanner(disk: { text: string; version: string }): void {
  diskOffer = disk;
  $("disk-banner").hidden = false;
}
function hideDiskBanner(): void {
  diskOffer = null;
  $("disk-banner").hidden = true;
}

function reloadFromDisk(): void {
  if (!diskOffer) return;
  const { text, version } = diskOffer;
  versions?.snapshot("before-reload");
  sync.dropManuscript(version);
  takeDiskText(text);
  hideDiskBanner();
  editor.focus();
}

// Keep mine: base the buffer on the disk version, so the save overwrites it.
function keepMine(): void {
  if (!diskOffer) return;
  const { version } = diskOffer;
  hideDiskBanner();
  sync.keepMine(version);
  editor.focus();
}

// metadata.json changed under this client. No banner: saves are section
// merges, so another writer's sections survive ours. Refresh an open panel
// only when it has nothing unsaved; otherwise refresh after its next save.
// ponytail: two writers on the same section, last write wins; a per-section
// version check (409 like the manuscript) if that ever bites.
async function refreshConfigFromRemote(): Promise<void> {
  if (!configPanel) return;
  if (sync.metadataBusy()) {
    metaStale = true;
    return;
  }
  const gen = ++metaFetchGen;
  try {
    const fresh = await fetchMetadata();
    if (gen !== metaFetchGen) return;
    if (sync.metadataBusy()) { // edited meanwhile
      metaStale = true;
      return;
    }
    metaStale = false;
    // Our own save's push can beat its response; the panel already shows that
    // version, and a rebuild would drop a value typed but not yet committed.
    if (fresh.version === sync.metaBase) return;
    metadata = fresh.metadata;
    sync.rebaseMetadata(fresh.version);
    styleUndo.reset(metadata);
    undoUi?.refresh();
    configPanel.refresh(metadata);
    setPaperStock(metadata.page?.paper);
  } catch {
    // 409/network — leave the panel as-is; the user can close and reopen.
  }
}

// Opens the view the step was made in, when it is in this mode's panel, so
// the author sees what changed back.
function stepStyle(dir: "undo" | "redo"): void {
  const step = metadata && styleUndo[dir](metadata);
  if (!step) return;
  saveMetadataSections(step.sections, false);
  metadata = step.metadata;
  $("preview").dataset.stale = "";
  configPanel?.refresh(metadata);
  if (
    step.view !== view &&
    step.view.startsWith("publish:") === (mode === "publish")
  ) configPanel?.open(step.view);
}

// Each gutter writes a CSS var on :root that the grids of #panes and #footer
// read.
function installGutters(): void {
  const panes = $("panes");
  const root = document.documentElement;
  for (
    const [id, cssVar, min] of [["gutter-tree", "--w-tree", 7.5], [
      "gutter-editor",
      "--w-editor",
      15,
    ]] as const // minimums in rem; a dragged width is px
  ) {
    const saved = localStorage.getItem(cssVar);
    if (saved) root.style.setProperty(cssVar, saved);
    const gutter = $(id);
    // Where the column starts, its width now, and the width the pointer and
    // the keys share: at least `min`, and 12.5rem left for whatever pane sits
    // to the right.
    const left = () =>
      (cssVar === "--w-tree"
        ? panes
        : ["editor", "config-overlay", "history-changes"].map($).find((el) =>
          el.checkVisibility()
        ) ?? panes).getBoundingClientRect().left;
    const rem = () => parseFloat(getComputedStyle(root).fontSize);
    const width = () => gutter.getBoundingClientRect().left - left();
    const resize = (px: number) => {
      const max = panes.getBoundingClientRect().right - left() - 12.5 * rem();
      const w = Math.min(Math.max(px, min * rem()), max);
      root.style.setProperty(cssVar, `${w}px`);
      gutter.setAttribute("aria-valuenow", String(Math.round(w)));
    };
    gutter.onfocus = () =>
      gutter.setAttribute("aria-valuenow", String(Math.round(width())));
    gutter.onkeydown = (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      resize(width() + (e.key === "ArrowLeft" ? -rem() : rem()));
      localStorage.setItem(cssVar, root.style.getPropertyValue(cssVar));
    };
    gutter.onpointerdown = (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add("dragging");
      const l = left();
      gutter.onpointermove = (m) => resize(m.clientX - l);
      gutter.onpointerup = () => {
        gutter.onpointermove = gutter.onpointerup = null;
        gutter.classList.remove("dragging");
        localStorage.setItem(cssVar, root.style.getPropertyValue(cssVar));
      };
    };
  }
}

// The first load follows the system, resolved by the inline script in
// index.html before first paint.
function installThemeToggle(): void {
  $("theme-toggle").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark"
      ? "light"
      : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  };
}

// Create a new manuscript (spec §7.9): the empty library's first step, and
// the switcher's New book.
const createManuscript = installCreateBook({
  backend: () => backend,
  books: () => books,
  setBooks: (b) => books = b,
  leave,
  restart: main,
});

async function main(): Promise<void> {
  backend = await connect();
  let skipped: string[];
  [{ books, skipped }, libId] = await Promise.all([
    backend.listBooks(),
    backend.libraryId().catch(() => null),
  ]);
  const lib = params.get("lib");
  if (lib && libId && lib !== libId) {
    location.replace(location.pathname); // someone else's place: start at home
    return;
  }
  const where = whereBooks(backend);
  showLibrary(backend, where, leave);
  setStatus("connected");
  // Folders whose names a book can't have are left out, and named, so one
  // never keeps the rest of the library from opening.
  const notShown = skipped.length
    ? `Not shown: ${skipped.join(", ")} — folder names may use letters, ` +
      "digits, dot, dash and underscore"
    : "";
  $("book-skipped").textContent = notShown;
  $("book-skipped").hidden = !notShown;
  if (!books.length) {
    createManuscript(false);
    $("create-err").textContent = notShown;
    return;
  }
  const requested = params.get("book");
  if (requested && books.includes(requested)) book = requested;
  else {
    book = await chooseBook({
      books,
      where,
      onChange: backend.kind === "local"
        ? () => changeLibrary({ store: backend.store!, books, leave })
        : undefined,
      onNew: () => createManuscript(true),
    });
    history.replaceState(null, "", here());
  }
  store(lastBookKey(where), book);

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
  switcher = installSwitcher({
    backend,
    where,
    book,
    edition,
    editions,
    books: () => books,
    sync: () => sync,
    editor: () => editor,
    leave,
    setMode,
    createManuscript,
    rebaseAfterRename,
  });
  fetchMetadata().then((m) => {
    switcher.setCrumbSize(m.metadata.page?.size);
    setPaperStock(m.metadata.page?.paper);
    showSpecBanner(m.metadata.spec);
  }, () => {
    // no size in the crumb; the Style panel reports the load error
  });

  const { text, version } = await fetchManuscript(book);
  sync = new Sync({
    backend,
    book,
    edition,
    clientId,
    base: version,
    metaBase: null, // until the Style panel loads it
    current: () => editor.state.doc.toString(),
    before: () => switcher.renaming(),
    onConflict: showDiskBanner, // the status follows from sync
    onRewrite: (rewritten) => {
      replaceBuffer(editor, rewritten);
      reparse(rewritten);
    },
    onStatus: syncChanged,
  });
  // Hiding or closing the tab sends what is waiting; closing prompts while
  // anything is unsaved (keepalive carries a save sent as the tab goes).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    void sync.flush();
    versions?.snapshot("close");
  });
  addEventListener("pagehide", () => void sync.flush());
  addEventListener("beforeunload", (e) => {
    if (!leaving && sync.hasUnsaved()) e.preventDefault();
  });
  // The list is fetched once per few seconds, not per keystroke in a slug's
  // completion; an add drops it so the new image shows next time.
  let imageList: Promise<ImageFile[]> | null = null;
  let imageListAt = 0;
  const images: ImageHost = {
    images: () => {
      if (!imageList || Date.now() - imageListAt > 5000) {
        imageList = backend.images(book);
        imageListAt = Date.now();
        imageList.catch(() => imageList = null);
      }
      return imageList;
    },
    url: (name) => backend.imageUrl(book, name),
    add: (file, slug) =>
      backend.addImage(book, file, slug).finally(() => imageList = null),
    note: imageNote,
  };
  editor = createEditor({
    parent: $("editor"),
    text,
    onDocChanged,
    onCursorLine: highlightTreeNode,
    images,
  });
  reparse(text);
  const textView = installTextView({
    editor,
    backend,
    book,
    setStatus,
    // The live pages' body text (the `body` style is `.bml`, spec §4.5).
    bodyFace: () => {
      const bml = $("preview").querySelector(
        ":scope > :not(.preview-stage) .bml",
      );
      return bml ? getComputedStyle(bml).fontFamily : null;
    },
  });
  $("disk-reload").onclick = reloadFromDisk;
  $("disk-keep").onclick = keepMine;
  const inspect = installInspect({
    container: $("preview"),
    catalog: styleCatalog,
    metadata: () => metadata ?? {},
    pageMap,
    mode: () => mode,
    style: pickStyle,
    source: goToLine,
  });
  // Inspect reads the book's metadata (running heads, units, where a value
  // comes from), which is otherwise fetched only when Style or Publish opens.
  $("inspect").addEventListener("click", () => void ensureConfigPanel());
  versions = installVersions({
    backend: () => backend,
    book: () => book,
    edition: () => edition,
    sync: () => sync,
    editor: () => editor,
    paint: (msg, cacheKey) => paint(msg, cacheKey),
    themes,
    syncUrl,
    pushPlace,
    changed: () => undoUi?.refresh(),
  });
  installShortcuts({
    mode: () => mode,
    panes: installPanes({ mode: () => mode }),
    textView,
    inspect,
    history: { escape: () => versions?.escape() ?? false },
    editor: () => editor,
    preview: $("preview"),
    createManuscript,
    ensureConfigPanel,
  });
  undoUi = installUndo({
    mode: () => mode,
    paused: () => versions?.at() != null,
    editor: () => editor,
    styles: {
      canUndo: styleUndo.canUndo,
      canRedo: styleUndo.canRedo,
      undo: () => stepStyle("undo"),
      redo: () => stepStyle("redo"),
    },
  });
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
  installPreviewZoom({ container: previewEl, out: $("zoom") });
  const refreshPageIndicator = installPageIndicator(
    previewEl,
    $("page-indicator"),
  );
  installPreviewClicks(previewEl, styleCatalog, {
    mode: () => mode,
    style: pickStyle,
    source: (line) => scrollEditorToLine(editor, line),
    addImage: (slug, file) => fillPlaceholder(images, slug, file),
    inspecting: inspect.active,
  });
  installStyleHover(previewEl, styleCatalog, () => mode, inspect.active);
  const key = cacheId(book, edition);
  const onClose = () => {
    // `deno task dev` restarts the server when app code changes; follow it
    // back with a fresh page, unless that would drop an unsaved edit.
    setStatus("offline", "Reconnecting…");
    const retry = setInterval(async () => {
      const up = await fetch("/").then((r) => r.ok, () => false);
      if (!up) return;
      clearInterval(retry);
      await sync.flush(); // a save that failed while it was down goes now
      if (sync.hasUnsaved()) {
        setStatus("offline", "Server restarted — reload to reconnect");
      } else location.reload();
    }, 500);
  };
  // Everything that reads the pages, once a layout is on screen.
  const afterLayout = () => {
    refreshPageIndicator();
    configPanel?.pagesChanged();
    followCursor(cursorLine);
    textView.refresh();
  };
  // A painted layout is the buffer's only while the buffer is the text it
  // was built from (`version`): a late push of an older version, or edits
  // since, leave it behind. Until then the pages stay dimmed, the turns shown
  // (mapped through each edit since) stay, and the layout isn't counted; a
  // save or reload that lands on its version catches it up (syncChanged).
  let behind: string | null = null;
  layoutCaughtUp = () => {
    if (behind === null || behind !== sync.base || sync.manuscriptDirty()) {
      return;
    }
    behind = null;
    setPageTurns(editor, pageTurns(previewEl));
    delete previewEl.dataset.stale;
    countLayout();
  };
  // Counts layouts that hold the buffer and that everything above has read:
  // what tests wait on (testing/wait.ts laidOut), rather than a sign of a page.
  const countLayout = () => {
    previewEl.dataset.layouts = String(
      Number(previewEl.dataset.layouts ?? 0) + 1,
    );
  };
  paint = (msg, cacheKey: string | null = key) => {
    renderPreview(msg, previewEl, cacheKey).then((problems) => {
      showPageProblems(problems);
      afterLayout();
      behind = msg.manuscriptVersion;
      layoutCaughtUp();
    }, (err) => {
      // The old pages stay up; their problems no longer describe this book.
      setStatus("error", `preview: ${brief(err)}`);
      showPageProblems([{ page: null, message: `preview failed: ${err}` }]);
    });
  };
  // What is restored is what should show, so it counts whatever its text;
  // its page turns, like a painted layout's, only if it is the buffer's.
  restore = (cached, version) => {
    delete previewEl.dataset.stale;
    behind = null;
    // None: the pages clear, and the book's first build paints when it lands.
    if (cached) restoreCachedRender(cached, previewEl, cached.imageUrl);
    else clearPreview(previewEl);
    showPageProblems(cached?.render.problems ?? []);
    afterLayout();
    if (version === sync.base && !sync.manuscriptDirty()) {
      setPageTurns(editor, pageTurns(previewEl));
    }
    countLayout();
  };
  // Restore before opening the socket so the previous render is on screen
  // when the first update lands, instead of a blank preview. Its text may be
  // older than the buffer's, so its page turns wait for that update.
  const cached = await loadCachedBook();
  if (cached) restore(cached);
  themes.installApply();
  const onMessage = (msg: ServerMessage) => {
    if (msg.type === "error") {
      setStatus("error", `build: ${brief(msg.message)}`);
      return;
    }
    showSync(sync.status()); // clears a build or preview error; Sync says if saved
    if (!themes.hold(msg) && !versions?.hold(msg)) {
      themes.lastShown = msg;
      paint(msg);
    }
    // Versions this client already reflects need nothing (spec §6).
    if (msg.manuscriptVersion !== sync.base) refreshFromRemote();
    if (msg.metadataVersion !== sync.metaBase) {
      metaStale = true; // until refreshConfigFromRemote fetches it
      refreshConfigFromRemote();
    }
  };
  backend.subscribe(book, edition, clientId, onMessage, onClose);
  const at = params.get("history"); // a link or a reload: nothing behind it
  if (at !== null) void versions.follow(at, false);
}

// A boot that throws must say so, not sit on "Connecting…" for good.
main().catch((err) => setStatus("failed", String(err)));
