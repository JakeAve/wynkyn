// web/main.js — Plan 1 preview shell: WebSocket client + Paged.js re-render.
// Plain JS on purpose: no bundler yet. Plan 2 introduces the TS build when
// CodeMirror lands. `Paged` is the CDN global from paged.js (index.html).

const clientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

let currentBlobUrl = null;
let rendering = false;
let queuedUpdate = null;

async function renderUpdate(update) {
  if (rendering) {
    queuedUpdate = update; // coalesce: only the latest pending update matters
    return;
  }
  rendering = true;
  try {
    $("book-title").textContent = update.bookTitle;
    const d = update.diagnostics;
    $("diagnostics").textContent = d.length
      ? `${d.length} parse note(s) — line ${d[0].line}: ${d[0].message}`
      : "";
    setFontLinks(update.fontLinks);

    // pagedCss must go through the Previewer so Paged.js processes @page /
    // string-set / target-counter; base + dom CSS ride along in the same sheet.
    const css = [update.baseCss, update.domCss, update.pagedCss].join("\n");
    const blobUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
    const container = $("preview");
    container.innerHTML = "";
    const previewer = new Paged.Previewer();
    await previewer.preview(update.html, [blobUrl], container);
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = blobUrl;
  } finally {
    rendering = false;
    if (queuedUpdate) {
      const next = queuedUpdate;
      queuedUpdate = null;
      renderUpdate(next);
    }
  }
}

function setFontLinks(html) {
  for (const el of document.querySelectorAll("link[data-book-font]")) el.remove();
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const link of tpl.content.querySelectorAll("link")) {
    link.setAttribute("data-book-font", "");
    document.head.appendChild(link);
  }
}

async function main() {
  const res = await fetch("/api/books");
  const { books } = await res.json();
  if (!books.length) {
    $("status").textContent = "no books found in books/";
    return;
  }
  const requested = params.get("book");
  const book = requested && books.includes(requested) ? requested : books[0];

  const ws = new WebSocket(
    `ws://${location.host}/ws?book=${encodeURIComponent(book)}&client=${clientId}`,
  );
  ws.onopen = () => {
    $("status").textContent = "live";
  };
  ws.onclose = () => {
    $("status").textContent = "disconnected — restart the server and reload";
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.origin === clientId) return; // our own save echoed back (spec §6)
    if (msg.type === "error") {
      $("status").textContent = `build error: ${msg.message}`;
      return;
    }
    $("status").textContent = "live";
    renderUpdate(msg);
  };
}

main();
