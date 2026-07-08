// web/src/app.ts — client orchestrator: book selection, editor, WebSocket, panes.
import { parse } from "../../parser/parser.ts";
import type { EditorView } from "@codemirror/view";
import { renderPreview, type UpdateMessage } from "./preview.ts";
import { applyDiagnostics, createEditor, replaceBuffer } from "./editor.ts";

const PARSE_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MS = 600;

const clientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

function setStatus(text: string): void {
  $("status").textContent = text;
}

let editor: EditorView;
let book: string;
let parseTimer = 0;
let saveTimer = 0;
let saveInFlight = false;
let queuedSaveText: string | null = null;
let dirty = false; // local edits newer than the last completed save
let remoteFetchGen = 0;

function onDocChanged(text: string): void {
  dirty = true;
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => reparse(text), PARSE_DEBOUNCE_MS);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(text), SAVE_DEBOUNCE_MS);
}

function reparse(text: string): void {
  const doc = parse(text);
  applyDiagnostics(editor, doc.diagnostics);
  $("diagnostics").textContent = doc.diagnostics.length
    ? `${doc.diagnostics.length} parse note(s) — line ${doc.diagnostics[0]!.line}: ${
      doc.diagnostics[0]!.message
    }`
    : "";
  // Task 6 adds: refreshTree(doc)
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
    if (editor.state.doc.toString() === text) dirty = false;
    setStatus("live");
  } catch (err) {
    setStatus(`save failed: ${err}`);
  } finally {
    saveInFlight = false;
    if (queuedSaveText !== null) {
      const next = queuedSaveText;
      queuedSaveText = null;
      saveInFlight = true;
      doSave(next); // catch-up save, no debounce — the debounce already happened once
    }
  }
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

async function main(): Promise<void> {
  const res = await fetch("/api/books");
  const { books } = (await res.json()) as { books: string[] };
  if (!books.length) {
    setStatus("no books found in books/");
    return;
  }
  const requested = params.get("book");
  book = requested && books.includes(requested) ? requested : books[0]!;
  document.title = `Book Editor — ${book}`;
  // Task 6 adds: populateSwitcher(books, book)

  const text = await fetchManuscript(book);
  editor = createEditor({ parent: $("editor"), text, onDocChanged });
  reparse(text);
  // Task 5 adds: buildSnippetToolbar()

  const previewEl = $("preview");
  const ws = new WebSocket(
    `ws://${location.host}/ws?book=${encodeURIComponent(book)}&client=${clientId}`,
  );
  ws.onopen = () => setStatus("live");
  ws.onclose = () => setStatus("disconnected — restart the server and reload");
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as UpdateMessage | {
      type: "error";
      origin: string | null;
      book: string;
      message: string;
    };
    if (msg.type === "error") {
      setStatus(`build error: ${msg.message}`);
      return;
    }
    setStatus("live");
    // Own-origin: preview only — never the buffer (spec §6 echo suppression).
    renderPreview(msg, previewEl);
    if (msg.origin !== clientId) refreshFromRemote();
  };
}

main();
