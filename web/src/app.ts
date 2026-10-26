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
  type UpdateMessage,
} from "./preview.ts";
import type { ServerMessage } from "../../server/pipeline.ts";
import {
  type CachedRender,
  cacheId,
  loadCachedRender,
  renderHash,
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
import { parseWordList, setSpeller } from "./spelling.ts";
import { SNIPPETS } from "./snippets.ts";
import { insertSnippet } from "./editor-insert.ts";
import { type ImageHost, pickImageFile } from "./editor-images.ts";
import type { ImageFile } from "../../server/images.ts";
import { buildTree } from "./tree-data.ts";
import { renderTree } from "./tree-view.ts";
import { type ConfigPanel, createConfigPanel } from "./config-panel.ts";
import type { Metadata } from "../../metadata/types.ts";
import { isNewerSpec, SPEC_VERSION } from "../../metadata/upgrade.ts";
import {
  appHref,
  editionHref,
  type EditionInfo,
  freeSlug,
  lineFromHash,
  slugify,
} from "./editions.ts";
import { editionToken, titleCase } from "../../server/editions.ts";
import { Sync, type SyncStatus } from "./sync.ts";
import type { Backend } from "./backend.ts";
import { importBooks } from "./fs-store.ts";
import { installSwitcher, type Switcher } from "./switcher.ts";
import { connect } from "./library.ts";
import { $, brief } from "./dom.ts";
import { importSource } from "../../server/import/mod.ts";
import { arrowKeys, themeCard } from "./panel-themes.ts";
import { applyTheme, THEMES } from "../../metadata/themes.ts";
import {
  fetchSource,
  openUrl,
  pasteSource,
  type WebSource,
} from "./web-source.ts";
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

// Author-facing status in the toolbar: a short phrase, so it clears the mode
// switch; the detail goes in the tooltip. "Saved" draws as a muted check (the
// text stays for screen readers) and says when in the tooltip.
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

// The writer's footer note: after an image drop or paste, for a few seconds;
// otherwise, with the cursor on an illustration, its print resolution.
let imageNoteTimer: ReturnType<typeof setTimeout> | undefined;
let cursorNote = { text: "", warn: false };
function showImageNote({ text, warn }: typeof cursorNote): void {
  const el = $("image-note");
  el.textContent = text;
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

// The cursor on an illustration's line or its caption (the line after): how
// its image prints where the live pages lay it out. A plate's copy has no
// data-line; it keeps the figure's id, the slug.
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

// An empty illustration placeholder's image (spec §7.6): the dropped file, or
// one picked now, saved as exactly its slug; the rebuild shows it.
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
// Both save queues and the versions they are based on (`sync.base`: every
// manuscript save names it, and one from a version that is no longer current
// is refused instead of overwriting a change this editor never saw). Made in
// main once the book, edition and manuscript version are known.
let sync: Sync;
let remoteFetchGen = 0;
// The disk text the changed-on-disk banner is offering, while it is up.
let diskOffer: { text: string; version: string } | null = null;
let metaStale = false; // metadata changed while the panel had unsaved edits
let metaFetchGen = 0;
let configPanel: ConfigPanel | null = null;
let books: string[] = []; // the library's, as last listed
let switcher: Switcher; // the crumb and the book/edition switcher, from main

function onDocChanged(text: string): void {
  $("preview").dataset.stale = ""; // dimmed until the render catches up
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => reparse(text), PARSE_DEBOUNCE_MS);
  sync.editManuscript(text);
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
  const lines = editor.state.doc.toString().split("\n");
  noteImageDpi(lines, line);
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

// Every page switch: send what is waiting first, and ask before dropping an
// edit whose save failed or that a conflict still holds.
let leaving = false; // the author chose to go: beforeunload asks nothing more
async function leave(href: string): Promise<void> {
  // No sync before a book opens (an empty library's first create).
  if (sync) {
    await sync.flush();
    if (
      sync.hasUnsaved() &&
      !confirm("Some changes aren't saved. Leave anyway?")
    ) return;
  }
  leaving = true;
  location.href = href;
}

// Sync's status onto the toolbar — the only way "Saved" gets there.
function showSync(s: SyncStatus): void {
  lastSaved = sync.savedAt;
  if (s.kind === "conflict") {
    setStatus("error", "something else touched the manuscript");
  } else if (s.kind === "error") setStatus("error", brief(s.detail));
  else setStatus(s.kind);
}

// The save state onto the page: sync.ts calls this whenever a save starts,
// lands or fails, or an edit changes what is unsaved.
let metaWasBusy = false;
function syncChanged(s: SyncStatus): void {
  // The banner's choices wait for a save in flight to settle: Reload under an
  // accepted save would show text the disk no longer has.
  for (const id of ["disk-reload", "disk-keep"]) {
    ($(id) as HTMLButtonElement).disabled = sync.manuscriptBusy();
  }
  if (diskOffer?.version === sync.base) hideDiskBanner(); // it was our own save
  showSync(s);
  const metaBusy = sync.metadataBusy();
  if (metaWasBusy && !metaBusy && metaStale) refreshConfigFromRemote();
  metaWasBusy = metaBusy;
}

function saveMetadataSections(sections: Partial<Metadata>): void {
  if ("page" in sections) switcher.setCrumbSize(sections.page?.size);
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
  addIsNames(m, isNames);
  return catalogFor(m);
};

// The Publish tab's e-book export, run once every style save has landed.
async function exportEpub(): Promise<EpubResult> {
  await sync.flush();
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
      const loaded = await fetchMetadata();
      metadata = loaded.metadata;
      sync.rebaseMetadata(loaded.version);
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
        tryTheme: (slug) => void tryTheme(slug),
        applyTheme: askApplyTheme,
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

// ---- Theme preview and Apply (spec §7.5) ----
// A previewed theme's build is on screen and nothing is saved. Pushed builds
// are held meanwhile; ending the preview shows the newest one.
// A null cacheKey paints without touching the book's cached render.
let paint: (msg: UpdateMessage, cacheKey?: string | null) => void = () => {}; // set in main
let restore: (cached: CachedRender) => void = () => {}; // set in main
let previewSlug: string | null = null; // the theme on screen, or null
let previewGen = 0; // bumped by every try and by the end, so a stale build drops
let previewFrom: string | null = null; // the manuscript version it was built from
let previewShown: UpdateMessage | null = null; // the theme's build on screen
let heldMsg: UpdateMessage | null = null; // newest push held while previewing
let lastShown: UpdateMessage | null = null; // the last real build painted

const themeName = (slug: string) =>
  THEMES.find((t) => t.slug === slug)?.name ?? slug;

// The edition's metadata with every style edit landed, so a theme goes over
// what the author sees. The held copy is current unless another writer changed
// metadata.json since (metaStale until refreshConfigFromRemote catches up).
async function settledMetadata(): Promise<Metadata> {
  await sync.flush();
  if (metadata && !metaStale) return metadata;
  return (await fetchMetadata()).metadata;
}

async function tryTheme(slug: string | null): Promise<void> {
  if (slug === null) return endPreview();
  const gen = ++previewGen;
  previewSlug = slug;
  $("preview").dataset.stale = "";
  configPanel?.themeTried(slug);
  try {
    const meta = applyTheme(await settledMetadata(), slug);
    const built = await backend.tryBuild(book, edition, meta);
    if (gen !== previewGen) return; // another card, or Discard, since
    previewFrom = built.manuscriptVersion;
    previewShown = { ...built, type: "update" };
    // Not cached: a reload must not open on a look never applied.
    paint(previewShown, null);
  } catch (err) {
    if (gen !== previewGen) return;
    endPreview(); // a held push must not stay held behind a bar for good
    setStatus("error", `preview: ${brief(err)}`);
  }
}

// Back to the book's own look: the newest held push, else the last build.
// `applied`: the previewed look is now the book's, so keep it on screen.
function endPreview(applied = false): void {
  if (previewSlug === null) return;
  previewSlug = null;
  const gen = ++previewGen;
  configPanel?.themeTried(null);
  if (applied && previewShown) lastShown = previewShown;
  const next = heldMsg ?? lastShown;
  heldMsg = previewShown = null;
  if (!applied) void showBookPages(next, gen);
}

// The book's cached render when it is what should show (no Paged.js pass),
// else a fresh render of `next`. With neither, the pages clear: the book's
// first build paints when it lands.
async function showBookPages(
  next: UpdateMessage | null,
  gen: number,
): Promise<void> {
  const cached = await loadCachedRender(cacheId(book, edition));
  if (gen !== previewGen) return; // a new preview since
  if (next && cached?.hash !== renderHash(next)) {
    lastShown = next;
    return paint(next);
  }
  restore(
    cached ??
      {
        hash: "",
        pages: "",
        styles: [],
        fontLinks: "",
        seed: {},
        problems: [],
      },
  );
}

// A push while previewing: held, and a manuscript change rebuilds the theme.
function holdForPreview(msg: UpdateMessage): boolean {
  if (previewSlug === null) return false;
  heldMsg = msg;
  if (msg.manuscriptVersion !== previewFrom) void tryTheme(previewSlug);
  return true;
}

// Apply always asks (spec §7.5): a new edition (the safe choice), or replace
// this edition's style. Cancel keeps the preview.
let applying: string | null = null; // the theme the dialog is asking about
function askApplyTheme(slug: string): void {
  const dlg = $("theme-dlg") as HTMLDialogElement;
  applying = slug;
  for (const el of dlg.querySelectorAll(".t-name")) {
    el.textContent = themeName(slug);
  }
  for (const el of dlg.querySelectorAll(".e-name")) {
    el.textContent = $("edition-name").textContent;
  }
  $("theme-err").textContent = "";
  if (!dlg.open) dlg.showModal();
}

// What a theme owns (spec §4.13), as the sections a save replaces.
const themeSections = (m: Metadata): Partial<Metadata> => ({
  fonts: m.fonts,
  elements: m.elements,
  numbering: m.numbering,
  running: m.running,
});

function installThemeApply(): void {
  const dlg = $("theme-dlg") as HTMLDialogElement;
  const buttons = [...dlg.querySelectorAll("button")];
  $("theme-cancel").onclick = () => dlg.close();
  const run = (act: (slug: string) => Promise<void>) => async () => {
    if (!applying) return;
    for (const b of buttons) b.disabled = true;
    try {
      await act(applying);
    } catch (err) {
      $("theme-err").textContent = brief(err);
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  };
  $("theme-new").onclick = run(async (slug) => {
    const applied = applyTheme(await settledMetadata(), slug);
    const taken = (await backend.editions(book)).flatMap((e) =>
      e.slug === null ? [] : [e.slug]
    );
    const next = freeSlug(slug, taken);
    await backend.createEdition(book, next, edition ?? "default");
    try {
      await backend.saveMetadata(book, next, themeSections(applied));
    } catch (err) {
      // An edition named for the theme but holding the old style misleads.
      await backend.deleteEdition(book, next).catch(() => {});
      throw err;
    }
    await leave(editionHref(book, next));
  });
  $("theme-replace").onclick = run(async (slug) => {
    const applied = applyTheme(await settledMetadata(), slug);
    metadata = applied;
    saveMetadataSections(themeSections(applied));
    void sync.flush(); // no debounce: the author chose this
    configPanel?.refresh(applied);
    endPreview(true);
    dlg.close();
  });
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
  if (next !== "style") endPreview(); // the panel ends it on Publish too
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
  replaceBuffer(editor, disk.text);
  reparse(disk.text);
  sync.rebase(disk.version);
  hideDiskBanner();
}

// A rename rewrote this book's {only} tokens on disk: this tab caused that
// change, so base the buffer on it rather than 409 its own next save (the
// server rewrites the old token in that save). A clean buffer takes the text.
async function rebaseAfterRename(): Promise<void> {
  const disk = await fetchManuscript(book);
  if (!sync.manuscriptDirty() && !sync.manuscriptBusy()) {
    replaceBuffer(editor, disk.text);
    reparse(disk.text);
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

// Reload: the disk wins — drop the unsaved edits and anything waiting to save.
function reloadFromDisk(): void {
  if (!diskOffer) return;
  const { text, version } = diskOffer;
  sync.dropManuscript(version);
  replaceBuffer(editor, text);
  reparse(text);
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
    metadata = fresh.metadata;
    sync.rebaseMetadata(fresh.version);
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

// Spell check (spec §7.3): the word list the Spelling menu picks, fetched
// once, and the book's dictionary.json, which Add to dictionary grows.
// Another language is one more list in vendor/ and one row here.
const WORD_LISTS: Record<string, { name: string; url: string }> = {
  en: { name: "English", url: "/vendor/words-en.txt" },
};
const wordLists = new Map<string, Promise<Set<string>>>();
async function spellCheck(lang: string): Promise<void> {
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
  serif: "ui-serif, Georgia, serif",
  sans: "system-ui, sans-serif",
  mono: "var(--mono)",
};
function installTextView(): void {
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
    spellCheck(prefs.spell);
  };
  apply();
  spellCheck(prefs.spell);
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
// Import a file or a web page, or start blank; all ask for a title, then open
// the book.
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
        backend.store!,
        dir.files,
      );
      const first = written[0];
      // Nothing skipped, or nowhere else to go: open the first book copied.
      if (first && (!skipped.length || !cancelable)) {
        await leave(editionHref(first, null));
        return;
      }
      if (!skipped.length) {
        err.textContent =
          "No book found: a book is a folder with a manuscript.md.";
        return;
      }
      err.textContent = `Already in the library: ${skipped.join(", ")}.` +
        (first ? ` Copied ${written.map(titleCase).join(", ")}.` : "");
      if (first) books = (await backend.listBooks()).books;
    } catch (e) {
      err.textContent = brief(e);
    }
  };
  $("create-blank").onclick = async () => {
    dlg.close();
    try {
      const got = await askTitle("", null, "Create book");
      if (!got) return createManuscript(cancelable);
      await backend.createBook(got.slug, got.title, got.theme);
      await leave(editionHref(got.slug, null));
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
  src: { name: string; bytes: Uint8Array | Promise<Uint8Array>; from?: string },
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
    await backend.importBook(got.slug, book, got.theme);
    await leave(editionHref(got.slug, null));
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
      if (books.includes(slug)) {
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
      chordLabel("Mod-A")
    }), copy (${chordLabel("Mod-C")}), and paste it here.`;
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
  // Folders whose names a book can't have are left out, and named, so one
  // never keeps the rest of the library from opening.
  const notShown = skipped.length
    ? `Not shown: ${skipped.join(", ")} — folder names may use letters, ` +
      "digits, dot, dash and underscore"
    : "";
  $("book-skipped").textContent = notShown;
  $("book-skipped").hidden = !notShown;
  if (!books.length) {
    // An empty library: the first book is the only thing to do.
    createManuscript(false);
    $("create-err").textContent = notShown;
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
  switcher = installSwitcher({
    backend,
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
    if (document.visibilityState === "hidden") void sync.flush();
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
    addImage: (slug, file) => fillPlaceholder(images, slug, file),
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
      await sync.flush(); // a save that failed while it was down goes now
      if (sync.hasUnsaved()) {
        setStatus("offline", "Server restarted — reload to reconnect");
      } else location.reload();
    }, 500);
  };
  paint = (msg, cacheKey: string | null = key) => {
    renderPreview(msg, previewEl, cacheKey).then((problems) => {
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
  };
  restore = (cached) => {
    restoreCachedRender(cached, previewEl);
    delete previewEl.dataset.stale;
    showPageProblems(cached.problems ?? []);
    refreshPageIndicator();
    configPanel?.pagesChanged();
    followCursor(cursorLine);
  };
  installThemeApply();
  const onMessage = (msg: ServerMessage) => {
    if (msg.type === "error") {
      setStatus("error", `build: ${brief(msg.message)}`);
      return;
    }
    showSync(sync.status()); // clears a build or preview error; Sync says if saved
    if (!holdForPreview(msg)) {
      lastShown = msg;
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
}

// A boot that throws must say so, not sit on "Connecting…" for good.
main().catch((err) => setStatus("failed", String(err)));
