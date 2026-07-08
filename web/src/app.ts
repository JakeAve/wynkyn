// web/src/app.ts — client orchestrator: book selection, WebSocket, panes.
import { renderPreview, type UpdateMessage } from "./preview.ts";

const clientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

function setStatus(text: string): void {
  $("status").textContent = text;
}

async function main(): Promise<void> {
  const res = await fetch("/api/books");
  const { books } = (await res.json()) as { books: string[] };
  if (!books.length) {
    setStatus("no books found in books/");
    return;
  }
  const requested = params.get("book");
  const book = requested && books.includes(requested) ? requested : books[0]!;
  document.title = `Book Editor — ${book}`;

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
    // Own-origin updates still re-render the preview; §6's echo suppression
    // protects the editor buffer (Task 4), not the preview.
    renderPreview(msg, previewEl);
  };
}

main();
