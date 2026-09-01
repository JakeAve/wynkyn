// web/src/preview.ts — Paged.js re-render + font links (spec §7.6).
// Paged.js is the CDN global from index.html; there is no npm build to bundle.
import { matchKey, type StyleEntry } from "./style-catalog.ts";
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
let queuedUpdate: { update: UpdateMessage; container: HTMLElement } | null =
  null;

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
  for (const el of document.querySelectorAll("link[data-book-font]")) {
    el.remove();
  }
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
export function scrollPreviewTo(
  anchorId: string,
  container: HTMLElement,
): void {
  const el = container.querySelector(`#${CSS.escape(anchorId)}`);
  // Scroll the page, not the element: the section start is the page start,
  // and instant scroll can't be raced by the next Paged.js re-render.
  (el?.closest(".pagedjs_page") ?? el)?.scrollIntoView({
    block: "start",
    behavior: "auto",
  });
}

// Click-to-style (spec §7.4): resolve the clicked node to a style-catalog
// key and hand it back; the clicked node is outlined until the next click
// or re-render. Link clicks that resolve are consumed so the TOC doesn't
// navigate the preview. `catalog` is read per click — `is:` entries change
// with the metadata.
export function installStyleClicks(
  container: HTMLElement,
  catalog: () => StyleEntry[],
  onPick: (key: string) => void,
): void {
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest(".preview-stage")) return;
    const chain: string[][] = [];
    for (
      let el: HTMLElement | null = target;
      el && el !== container;
      el = el.parentElement
    ) {
      chain.push([...el.classList]);
    }
    const key = matchKey(chain, catalog());
    if (!key) return;
    e.preventDefault();
    container.querySelector("[data-style-selected]")?.removeAttribute(
      "data-style-selected",
    );
    target.setAttribute("data-style-selected", "");
    onPick(key);
  });
}

// "Page 12 of 208" for the footer: the page nearest the pane's vertical
// centre, refreshed on scroll and after each render.
export function installPageIndicator(
  container: HTMLElement,
  out: HTMLElement,
): () => void {
  let raf = 0;
  const update = () => {
    raf = 0;
    const pages = container.querySelectorAll<HTMLElement>(
      ":scope > :not(.preview-stage) .pagedjs_page",
    );
    if (!pages.length) {
      out.textContent = "";
      return;
    }
    const mid = container.getBoundingClientRect().top +
      container.clientHeight / 2;
    let best = pages[0]!;
    let bestDist = Infinity;
    for (const p of pages) {
      const r = p.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    out.textContent = `Page ${
      best.dataset.pageNumber ?? "?"
    } of ${pages.length}`;
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  container.addEventListener("scroll", schedule, { passive: true });
  return schedule;
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
