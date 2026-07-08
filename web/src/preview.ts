// web/src/preview.ts — Paged.js re-render + font links (spec §7.6).
// Paged.js is the CDN global from index.html; there is no npm build to bundle.
declare const Paged: {
  Previewer: new () => {
    preview(html: string, css: string[], el: Element): Promise<unknown>;
  };
};

export interface UpdateMessage {
  type: "update";
  origin: string | null;
  book: string;
  bookTitle: string;
  html: string;
  baseCss: string;
  domCss: string;
  pagedCss: string;
  fontLinks: string;
  diagnostics: { line: number; message: string }[];
}

let currentBlobUrl: string | null = null;
let rendering = false;
let queuedUpdate: { update: UpdateMessage; container: HTMLElement } | null = null;

export async function renderPreview(
  update: UpdateMessage,
  container: HTMLElement,
): Promise<void> {
  if (rendering) {
    queuedUpdate = { update, container }; // coalesce: only the latest pending update matters
    return;
  }
  rendering = true;
  try {
    setFontLinks(update.fontLinks);
    // pagedCss must go through the Previewer so Paged.js processes @page /
    // string-set / target-counter; base + dom CSS ride along in the same sheet.
    const css = [update.baseCss, update.domCss, update.pagedCss].join("\n");
    const blobUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
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
      renderPreview(next.update, next.container);
    }
  }
}

export function setFontLinks(html: string): void {
  for (const el of document.querySelectorAll("link[data-book-font]")) el.remove();
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const link of tpl.content.querySelectorAll("link")) {
    link.setAttribute("data-book-font", "");
    document.head.appendChild(link);
  }
}

// Scroll the preview pane to a rendered section anchor (renderer id formats:
// "<slug>" for parts/chapters, "matter-<type>[-<label>]" for matter blocks).
// Duplicate slugs resolve to the first occurrence, per spec §3.2.4.
export function scrollPreviewTo(anchorId: string, container: HTMLElement): void {
  const el = container.querySelector(`#${CSS.escape(anchorId)}`);
  el?.scrollIntoView({ block: "start", behavior: "smooth" });
}
