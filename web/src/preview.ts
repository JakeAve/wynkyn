// web/src/preview.ts — Paged.js re-render + font links (spec §7.6).
// Paged.js is the global from the vendored /vendor/paged.js (index.html loads
// it, dev-server.ts serves it); there is no npm build to bundle.
import type { ServerMessage } from "../../server/pipeline.ts";
import type { PageNumberingConfig } from "../../metadata/css-generator.ts";
import {
  matchKey,
  type PreviewLink,
  type StyleEntry,
} from "./style-catalog.ts";
import {
  type CachedRender,
  renderHash,
  saveCachedRender,
} from "./preview-cache.ts";
import type { PageProblem, Seed } from "../../renderer/page-map-types.ts";

interface RenderResult {
  seed: Seed;
  problems: PageProblem[];
}
interface Previewer {
  // Polisher: styleEl holds the rules Paged.js generates (insertRule, so no
  // textContent); inserted holds its base sheet and the converted book CSS.
  polisher: {
    styleEl: HTMLStyleElement;
    inserted: HTMLStyleElement[];
    destroy(): void;
  };
  // preview() resolves to the chunker; folios.js leaves the result on it.
  preview(
    html: string,
    css: string[],
    el: Element,
  ): Promise<{ pageMapResult: RenderResult }>;
}
declare const Paged: {
  Previewer: new (
    options: { pageMap: { seed: Seed; numbering: PageNumberingConfig } },
  ) => Previewer;
};
// renderer/folios.js, imported by app.ts.
declare const BookPageMap: {
  settle(
    renderOnce: (seed: Seed) => Promise<RenderResult>,
    seed: Seed,
    maxPasses?: number,
  ): Promise<RenderResult & { passes: number }>;
};

export type UpdateMessage = Extract<ServerMessage, { type: "update" }>;

let currentBlobUrl: string | null = null;
let rendering = false;
// The hash of the render on screen or being produced for it; every accepted
// call sets it synchronously, so a queued render can't be skipped as "same".
let targetHash: string | null = null;
// The Previewer whose pages are on screen; its polisher owns their sheets.
let livePreviewer: Previewer | null = null;
// The sheets of a render restored from the cache, which has no Previewer.
let restoredStyles: Element[] = [];
// The on-screen render's anchor folios seed the next render, so it usually
// settles in one pass.
let seed: Seed = {};
let problems: PageProblem[] = [];
// The render for targetHash (in flight, queued or done); null after a restore.
let pending: Promise<PageProblem[]> | null = null;
let queuedUpdate: {
  update: UpdateMessage;
  container: HTMLElement;
  cacheKey: string;
  done: PromiseWithResolvers<PageProblem[]>;
} | null = null;

// Resolves to the page-map problems of the render that ends up on screen.
export function renderPreview(
  update: UpdateMessage,
  container: HTMLElement,
  cacheKey: string,
): Promise<PageProblem[]> {
  const hash = renderHash(update);
  // Same content as what's on screen or already on its way (e.g. the first
  // update after a restore): Paged.js would spend seconds reproducing it, so
  // share that render's outcome.
  if (hash === targetHash) return pending ?? Promise.resolve(problems);
  targetHash = hash;
  if (rendering) {
    // coalesce: only the latest pending update matters, and every caller
    // waiting on the queue gets its result
    queuedUpdate = {
      update,
      container,
      cacheKey,
      done: queuedUpdate?.done ?? Promise.withResolvers(),
    };
    return pending = queuedUpdate.done.promise;
  }
  return pending = runRender(update, container, cacheKey, hash);
}

async function runRender(
  update: UpdateMessage,
  container: HTMLElement,
  cacheKey: string,
  hash: string,
): Promise<PageProblem[]> {
  rendering = true;
  try {
    setFontLinks(update.fontLinks);
    // pagedCss must go through the Previewer so Paged.js processes @page;
    // base + dom CSS ride along in the same sheet.
    const css = [update.baseCss, update.domCss, update.pagedCss].join("\n");
    const blobUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
    // Stage the new render invisibly next to the live pages, then swap — the
    // old pages stay on screen for the seconds Paged.js takes, no white flash.
    const stage = document.createElement("div");
    stage.className = "preview-stage";
    container.appendChild(stage);
    // `as`: keeps TS from narrowing this to undefined past the closure.
    let previewer = undefined as Previewer | undefined;
    let result: RenderResult;
    try {
      // Each pass renders into the stage; a pass that didn't settle leaves
      // its pages and sheets behind for the next one to clear.
      result = await BookPageMap.settle(async (passSeed) => {
        if (previewer) {
          previewer.polisher.destroy();
          stage.replaceChildren();
        }
        previewer = new Paged.Previewer({
          pageMap: { seed: passSeed, numbering: update.pageNumbering },
        });
        return (await previewer.preview(update.html, [blobUrl], stage))
          .pageMapResult;
      }, seed);
    } catch (err) {
      previewer?.polisher.destroy();
      stage.remove();
      URL.revokeObjectURL(blobUrl);
      throw err;
    }
    for (const old of container.children) if (old !== stage) old.remove();
    // The old sheets belong to the pages that just went away.
    livePreviewer?.polisher.destroy();
    for (const el of restoredStyles) el.remove();
    restoredStyles = [];
    livePreviewer = previewer!;
    stage.className = "";
    fitPreview(container);
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = blobUrl;
    ({ seed, problems } = result);
    const { styleEl, inserted } = livePreviewer.polisher;
    // Head order is cascade order: the base sheet, styleEl, then the book CSS.
    const styles = [...document.head.querySelectorAll("style")]
      .filter((el) => el === styleEl || inserted.includes(el))
      .map((el) =>
        [...el.sheet?.cssRules ?? []].map((r) => r.cssText).join("\n")
      );
    void saveCachedRender(cacheKey, {
      hash,
      pages: container.innerHTML,
      styles,
      fontLinks: update.fontLinks,
      seed,
      problems,
    }); // fire-and-forget: never throws, and the render shouldn't wait on it
    return problems;
  } finally {
    rendering = false;
    if (queuedUpdate) {
      const next = queuedUpdate;
      queuedUpdate = null;
      // targetHash is already the queued update's hash; clear it so the
      // sameness check doesn't skip the very render it was set for.
      targetHash = null;
      renderPreview(next.update, next.container, next.cacheKey).then(
        next.done.resolve,
        next.done.reject,
      );
    }
  }
}

// Put a cached render on screen without Paged.js: its pages plus the sheets
// Paged.js had inserted for them. targetHash is set so the first WebSocket
// update, which carries the same content, is skipped.
export function restoreCachedRender(
  cached: CachedRender,
  container: HTMLElement,
): void {
  setFontLinks(cached.fontLinks);
  restoredStyles = cached.styles.map((css) => {
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  });
  container.innerHTML = cached.pages;
  targetHash = cached.hash;
  pending = null;
  seed = cached.seed ?? {};
  problems = cached.problems ?? [];
  fitPreview(container);
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

// The app's mode (spec §7.1): what the middle column edits.
export type Mode = "write" | "style" | "publish";

// The stylable node at or above `target` and its catalog key: matchKey picks
// the entry from the target's class+tag chain, closest() finds the node its
// selector matched. Nothing inside a staged (half-rendered) preview. Page
// furniture (folios, running heads) has no source line, so it always styles.
function resolveStyle(
  target: Element | null,
  container: HTMLElement,
  catalog: StyleEntry[],
): { key: string; el: Element; furniture: boolean } | null {
  if (!target || target.closest(".preview-stage")) return null;
  const chain: string[][] = [];
  for (
    let el: Element | null = target;
    el && el !== container;
    el = el.parentElement
  ) {
    chain.push([...el.classList, el.localName]); // tag last: matches `.bml p`
  }
  const key = matchKey(chain, catalog);
  const entry = catalog.find((e) => e.key === key);
  const el = entry && target.closest(entry.selector);
  if (!entry || !el || !container.contains(el)) return null;
  const furniture = entry.section === "numbering" ||
    entry.section === "running";
  return { key: entry.key, el, furniture };
}

// Where a click on the pages goes (spec §7.4): in Style, to the clicked
// element's style; in Write, to its manuscript line (the nearest rendered
// block's data-line). Furniture always goes to its style. A styled node is
// outlined until the next pick or re-render; consumed clicks don't let the
// TOC's links navigate. `catalog` is read per click — `is:` entries change
// with the metadata.
export function installPreviewClicks(
  container: HTMLElement,
  catalog: () => StyleEntry[],
  on: { mode(): Mode; style(key: string): void; source(line: number): void },
): void {
  container.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    const mode = on.mode();
    const hit = resolveStyle(target, container, catalog());
    if (hit && (hit.furniture || mode === "style")) {
      e.preventDefault();
      container.querySelector("[data-style-selected]")?.removeAttribute(
        "data-style-selected",
      );
      hit.el.setAttribute("data-style-selected", "");
      on.style(hit.key);
      return;
    }
    if (mode !== "write" || target?.closest(".preview-stage")) return;
    const line = Number(
      target?.closest("[data-line]")?.getAttribute("data-line"),
    );
    if (!line) return;
    e.preventDefault();
    on.source(line);
  });
}

// Hover outline (spec R3): the node a click would style, once per frame —
// everywhere in Style, only furniture in Write. A re-render replaces the
// nodes, which takes the attribute with them.
export function installStyleHover(
  container: HTMLElement,
  catalog: () => StyleEntry[],
  mode: () => Mode,
): void {
  let raf = 0;
  let pointed: Element | null = null;
  let hovered: Element | null = null;
  const set = (el: Element | null) => {
    if (el === hovered) return;
    hovered?.removeAttribute("data-style-hover");
    hovered = el;
    el?.setAttribute("data-style-hover", "");
  };
  container.addEventListener("mousemove", (e) => {
    pointed = e.target as Element | null;
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      const hit = resolveStyle(pointed, container, catalog());
      set(hit && (hit.furniture || mode() === "style") ? hit.el : null);
    });
  }, { passive: true });
  container.addEventListener("mouseleave", () => {
    cancelAnimationFrame(raf);
    raf = 0;
    set(null);
  });
}

// The panel's view of the preview (spec R3): the pages an entry appears on,
// outlining every match, scrolling from one to the next.
export function previewLink(
  container: HTMLElement,
  catalog: () => StyleEntry[],
): PreviewLink {
  let step: { key: string; el: Element; i: number } | null = null;
  const matches = (key: string): Element[] => {
    const entry = catalog().find((e) => e.key === key);
    if (!entry) return [];
    const margin = entry.section === "numbering" ||
      entry.section === "running";
    return [...container.querySelectorAll(entry.selector)].filter((el) =>
      !el.closest(".preview-stage") && (!margin || marginShows(el))
    );
  };
  // Page counts hold until the pages they were counted on are replaced (a
  // re-render or a cache restore disconnects the first live page).
  const counts = new Map<string, number>();
  let countedOn: Element | null = null;
  const firstPage = () =>
    [...container.querySelectorAll(".pagedjs_page")].find((p) =>
      !p.closest(".preview-stage")
    ) ?? null;
  const pages = () => [...container.querySelectorAll<HTMLElement>(
    ":scope > :not(.preview-stage) .pagedjs_page",
  )];
  return {
    pages,
    pageCount: () => pages().length,
    endsWithColophon: () =>
      pages().at(-1)?.querySelector(".matter-colophon") != null,
    pagesFor(key) {
      if (!countedOn?.isConnected) {
        counts.clear();
        countedOn = firstPage();
      }
      let n = counts.get(key);
      if (n === undefined) {
        n = new Set(matches(key).map((el) => el.closest(".pagedjs_page")))
          .size;
        if (countedOn) counts.set(key, n); // nothing paginated yet: don't keep
      }
      return n;
    },
    highlight(key, on) {
      for (const el of matches(key)) el.toggleAttribute("data-style-hl", on);
    },
    // Steps through the matches, wrapping; a new key, or a re-render (which
    // disconnects the last revealed node), starts again from the first.
    reveal(key) {
      const all = matches(key);
      const i = step?.key === key && step.el.isConnected
        ? (step.i + 1) % all.length
        : 0;
      const el = all[i];
      step = el ? { key, el, i } : null;
      (el?.closest(".pagedjs_page") ?? el)?.scrollIntoView({
        block: "start",
        behavior: "auto",
      });
    },
  };
}

// A margin box's text is CSS-generated (Paged.js puts the @page content on
// its .pagedjs_margin-content::after, fed by --folio and friends), so
// "non-empty" means that content is more than empty strings.
function marginShows(box: Element): boolean {
  const inner = box.querySelector(".pagedjs_margin-content");
  if (!inner || !box.classList.contains("hasContent")) return false;
  const content = getComputedStyle(inner, "::after").content;
  return content !== "none" && content !== "normal" &&
    content.replace(/["\s]/g, "") !== "";
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
