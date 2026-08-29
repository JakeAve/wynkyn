// web/src/app.ts — client orchestrator: book selection, editor, WebSocket, panes.
import { parse } from "../../parser/parser.ts";
import type { EditorView } from "@codemirror/view";
import type { BmlDocument } from "../../parser/types.ts";
import { catalogFor } from "./style-catalog.ts";
import {
  fitPreview,
  installPageIndicator,
  installStyleClicks,
  renderPreview,
  scrollPreviewTo,
  type UpdateMessage,
} from "./preview.ts";
import { applyDiagnostics, createEditor, replaceBuffer, scrollEditorToLine } from "./editor.ts";
import { applySnippet, SNIPPETS } from "./snippets.ts";
import { buildTree } from "./tree-data.ts";
import { renderTree } from "./tree-view.ts";
import { type ConfigPanel, createConfigPanel } from "./config-panel.ts";
import type { Metadata } from "../../metadata/types.ts";

const PARSE_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MS = 600;

const clientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

// Author-facing status: a glyph + a plain phrase; the raw error goes in the
// tooltip rather than the footer.
type StatusKind = "connecting" | "saved" | "saving" | "error" | "offline";
const STATUS_TEXT: Record<StatusKind, string> = {
  connecting: "◌ Connecting…",
  saved: "● Saved",
  saving: "◌ Saving…",
  error: "✕ Not saved",
  offline: "✕ Disconnected — restart the server and reload",
};
function setStatus(kind: StatusKind, detail?: string): void {
  const el = $("status");
  el.textContent = detail && kind === "error" ? `${STATUS_TEXT[kind]} — ${detail}` : STATUS_TEXT[kind];
  el.dataset.kind = kind;
  el.title = detail ?? "";
}

// Short, readable tail of an error for the footer; full text stays in the title.
function brief(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 80);
}

let editor: EditorView;
let book: string;
let parseTimer = 0;
let saveTimer = 0;
let saveInFlight = false;
let queuedSaveText: string | null = null;
let dirty = false; // local edits newer than the last completed save
let remoteFetchGen = 0;
let configPanel: ConfigPanel | null = null;
let metaSaveInFlight = false;
let queuedMetaSections: Partial<Metadata> | null = null;

function onDocChanged(text: string): void {
  dirty = true;
  setStatus("saving");
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => reparse(text), PARSE_DEBOUNCE_MS);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(text), SAVE_DEBOUNCE_MS);
}

function reparse(text: string): void {
  const doc = parse(text);
  applyDiagnostics(editor, doc.diagnostics);
  const diag = $("diagnostics");
  const first = doc.diagnostics[0];
  diag.textContent = first
    ? `▲ ${doc.diagnostics.length} parse note${doc.diagnostics.length > 1 ? "s" : ""} — line ${first.line}: ${first.message}`
    : "";
  diag.title = first ? "click to jump to the first note" : "";
  diag.onclick = first ? () => scrollEditorToLine(editor, first.line) : null;
  refreshTree(doc);
}

let treeLines: number[] = []; // start line of every tree node, ascending
let cursorLine = 1;

function refreshTree(doc: BmlDocument): void {
  const nodes = buildTree(doc);
  treeLines = nodes.flatMap((n) => [n.line, ...n.children.map((c) => c.line)]).sort((a, b) => a - b);
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
  tree.querySelector(`[data-line="${best}"]`)?.setAttribute("aria-current", "true");
}

function populateSwitcher(books: string[], active: string): void {
  const sel = $("book-switcher") as HTMLSelectElement;
  sel.innerHTML = "";
  for (const b of books) sel.appendChild(new Option(b, b, false, b === active));
  sel.onchange = () => {
    // Full navigation, not in-place teardown: clean WS/editor/tree state.
    location.search = `?book=${encodeURIComponent(sel.value)}`;
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
    const res = await fetch(`/api/books/${encodeURIComponent(book)}/manuscript`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, clientId }),
    });
    if (!res.ok) throw new Error(await res.text());
    if (editor.state.doc.toString() === text) {
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
  if (metaSaveInFlight) {
    queuedMetaSections = { ...queuedMetaSections, ...sections };
    return;
  }
  metaSaveInFlight = true;
  doMetadataSave(sections);
}

async function doMetadataSave(sections: Partial<Metadata>): Promise<void> {
  try {
    const res = await fetch(`/api/books/${encodeURIComponent(book)}/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections, clientId }),
    });
    if (!res.ok) throw new Error(await res.text());
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
      doMetadataSave(next);
    }
  }
}

async function fetchMetadata(): Promise<Metadata> {
  const res = await fetch(`/api/books/${encodeURIComponent(book)}/metadata`);
  if (!res.ok) throw new Error(`metadata load failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { metadata: Metadata }).metadata;
}

let metadata: Metadata | null = null; // last fetched; the style catalog reads `is` from it

async function ensureConfigPanel(): Promise<ConfigPanel | null> {
  if (configPanel) return configPanel;
  try {
    metadata = await fetchMetadata();
    configPanel = createConfigPanel({
      overlay: $("config-overlay"),
      metadata,
      saveSections: saveMetadataSections,
    });
    return configPanel;
  } catch (err) {
    setStatus("error", brief(err)); // e.g. 409 corrupt metadata.json — fix on disk
    return null;
  }
}

async function toggleConfigPanel(): Promise<void> {
  (await ensureConfigPanel())?.toggle();
}

// Preview click → Styles section on that element (spec §7.4).
async function pickStyle(key: string): Promise<void> {
  (await ensureConfigPanel())?.selectStyle(key);
}

async function fetchManuscript(name: string): Promise<string> {
  const res = await fetch(`/api/books/${encodeURIComponent(name)}/manuscript`);
  if (!res.ok) throw new Error(`manuscript load failed: ${res.status}`);
  return ((await res.json()) as { text: string }).text;
}

// A foreign-origin update means the file changed outside this editor — pull
// the new source, but never over unsaved local edits (they win; the next
// save round-trip reconciles).
async function refreshFromRemote(): Promise<void> {
  const gen = ++remoteFetchGen;
  const text = await fetchManuscript(book);
  if (gen !== remoteFetchGen || dirty || saveInFlight) return;
  replaceBuffer(editor, text);
  reparse(text);
}

// A foreign-origin update may mean metadata.json changed outside this client.
// Refresh an open panel only when it has nothing unsaved — local edits win,
// same policy as the editor buffer.
async function refreshConfigFromRemote(): Promise<void> {
  if (!configPanel || configPanel.isDirty() || metaSaveInFlight) return;
  try {
    metadata = await fetchMetadata();
    configPanel.refresh(metadata);
  } catch {
    // 409/network — leave the panel as-is; the user can close and reopen.
  }
}

type PaneMode = "split" | "editor" | "preview";
let paneMode: PaneMode = "split";

// Expands the editor or preview pane by hiding the other; the tree stays put
// since it's navigation, not content to expand into. Clicking the toggle for
// the already-active mode restores the split view. Session-only — resets on
// reload/book-switch like the rest of the UI's transient state.
function setPaneMode(mode: PaneMode): void {
  paneMode = mode;
  const panes = $("panes");
  panes.classList.remove("pane-mode-editor", "pane-mode-preview");
  if (mode !== "split") panes.classList.add(`pane-mode-${mode}`);
  $("pane-toggle-editor").setAttribute("aria-pressed", String(mode === "editor"));
  $("pane-toggle-preview").setAttribute("aria-pressed", String(mode === "preview"));
}

const STRUCTURE_SNIPPETS = new Set(["matter", "part", "chapter", "heading", "subheading"]);
const MOD = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
// Keyboard chords. Snippet chords insert via applySnippet; the rest are UI.
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
  return `Mod-${e.shiftKey ? "Shift-" : ""}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
}
function installShortcuts(): void {
  const bySnippet = new Map(SNIPPETS.filter((s) => SNIPPET_KEYS[s.label]).map((s) => [SNIPPET_KEYS[s.label], s]));
  document.addEventListener("keydown", (e) => {
    const chord = chordOf(e);
    if (!chord) return;
    const snippet = bySnippet.get(chord);
    if (snippet) {
      editor.dispatch(applySnippet(editor.state, snippet));
      editor.focus();
    } else if (chord === "Mod-1") setPaneMode("editor");
    else if (chord === "Mod-2") setPaneMode("split");
    else if (chord === "Mod-3") setPaneMode("preview");
    else if (chord === "Mod-,") toggleConfigPanel();
    else return;
    e.preventDefault();
  }, true);
  $("pane-toggle-editor").title += ` (${chordLabel("Mod-1")}; ${chordLabel("Mod-2")} restores split)`;
  $("pane-toggle-preview").title += ` (${chordLabel("Mod-3")}; ${chordLabel("Mod-2")} restores split)`;
  $("config-button").title += ` (${chordLabel("Mod-,")})`;
}

// Snippets live in a grouped dropdown (structure / block / inline) rather than
// 19 flat toolbar buttons — the toolbar overflowed and hid the status text.
function buildSnippetToolbar(): void {
  const menu = $("insert-menu") as HTMLDetailsElement;
  const bar = $("snippet-buttons");
  const groups = { structure: [] as typeof SNIPPETS, block: [] as typeof SNIPPETS, inline: [] as typeof SNIPPETS };
  for (const s of SNIPPETS) {
    (STRUCTURE_SNIPPETS.has(s.label) ? groups.structure : s.kind === "block" ? groups.block : groups.inline).push(s);
  }
  for (const [name, list] of Object.entries(groups)) {
    const col = document.createElement("div");
    col.className = "group";
    const h = document.createElement("h4");
    h.className = "caption";
    h.textContent = name;
    col.appendChild(h);
    for (const s of list) {
      const b = document.createElement("button");
      b.textContent = s.label;
      const chord = SNIPPET_KEYS[s.label];
      if (chord) {
        const kbd = document.createElement("kbd");
        kbd.textContent = chordLabel(chord);
        b.appendChild(kbd);
      }
      b.onclick = () => {
        menu.open = false;
        editor.dispatch(applySnippet(editor.state, s));
        editor.focus();
      };
      col.appendChild(b);
    }
    bar.appendChild(col);
  }
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node)) menu.open = false;
  });
}

async function main(): Promise<void> {
  const res = await fetch("/api/books");
  const { books } = (await res.json()) as { books: string[] };
  if (!books.length) {
    setStatus("error", "no books found in books/");
    return;
  }
  const requested = params.get("book");
  book = requested && books.includes(requested) ? requested : books[0]!;
  document.title = `Book Editor — ${book}`;
  populateSwitcher(books, book);

  const text = await fetchManuscript(book);
  editor = createEditor({ parent: $("editor"), text, onDocChanged, onCursorLine: highlightTreeNode });
  reparse(text);
  buildSnippetToolbar();
  installShortcuts();
  $("config-button").onclick = () => {
    toggleConfigPanel();
  };
  $("pane-toggle-editor").onclick = () => {
    setPaneMode(paneMode === "editor" ? "split" : "editor");
  };
  $("pane-toggle-preview").onclick = () => {
    setPaneMode(paneMode === "preview" ? "split" : "preview");
  };

  const previewEl = $("preview");
  new ResizeObserver(() => fitPreview(previewEl)).observe(previewEl);
  const refreshPageIndicator = installPageIndicator(previewEl, $("page-indicator"));
  installStyleClicks(previewEl, () => catalogFor(metadata ?? {}), pickStyle);
  const ws = new WebSocket(
    `ws://${location.host}/ws?book=${encodeURIComponent(book)}&client=${clientId}`,
  );
  ws.onopen = () => setStatus("saved");
  ws.onclose = () => setStatus("offline");
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as UpdateMessage | {
      type: "error";
      origin: string | null;
      book: string;
      message: string;
    };
    if (msg.type === "error") {
      setStatus("error", `build: ${brief(msg.message)}`);
      return;
    }
    if (!dirty && !saveInFlight) setStatus("saved");
    // Own-origin: preview only — never the buffer (spec §6 echo suppression).
    renderPreview(msg, previewEl).then(refreshPageIndicator);
    if (msg.origin !== clientId) {
      refreshFromRemote();
      refreshConfigFromRemote();
    }
  };
}

main();
