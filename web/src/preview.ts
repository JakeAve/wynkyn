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
    // Stage the new render invisibly next to the live pages, then swap — the
    // old pages stay on screen for the seconds Paged.js takes, no white flash.
    const stage = document.createElement("div");
    stage.className = "preview-stage";
    container.appendChild(stage);
    const previewer = new Paged.Previewer();
    await previewer.preview(update.html, [blobUrl], stage);
    for (const old of container.children) if (old !== stage) old.remove();
    stage.className = "";
    fitPreview(container);
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
  // Scroll the page, not the element: the section start is the page start,
  // and instant scroll can't be raced by the next Paged.js re-render.
  (el?.closest(".pagedjs_page") ?? el)?.scrollIntoView({ block: "start", behavior: "auto" });
}

// Fit a full spread (two pages + gap) to the pane width via CSS zoom, never
// upscaling past 1:1. Called after each render and on pane resize.
const SPREAD_GAP = 8;
const PANE_PADDING = 48; // 2×16px pane padding + slack so the spread never wraps
export function fitPreview(container: HTMLElement): void {
  const pages = container.querySelector<HTMLElement>(".pagedjs_pages");
  const page = pages?.querySelector<HTMLElement>(".pagedjs_page");
  if (!pages || !page) return;
  // Computed width is the unzoomed CSS length, so measuring is zoom-independent.
  const spread = 2 * parseFloat(getComputedStyle(page).width) + SPREAD_GAP;
  const k = Math.min(1, (container.clientWidth - PANE_PADDING) / spread);
  // Set on the container (not .pagedjs_pages, which Paged.js recreates) so the
  // zoom survives re-renders and pages don't flash at 1:1 mid-render.
  container.style.setProperty("--preview-zoom", k.toFixed(3));
}
