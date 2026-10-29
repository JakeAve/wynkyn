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
  type CachedSegment,
  loadCachedSegment,
  saveCachedRender,
  segmentKey,
  segmentStyleHash,
  shiftLines,
  styleHash,
  tokenImages,
  untokenImages,
} from "./preview-cache.ts";
import { scopeSheet } from "./scope-css.ts";
import type {
  Laid,
  PageEntry,
  PageProblem,
  Seed,
  Segment,
} from "../../renderer/page-map-types.ts";

interface RenderResult {
  map: PageEntry[];
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
  // The render queue's scheduler (see renderTick below); the page blanks
  // are made from.
  chunker: {
    q: { tick: (cb: () => void) => void };
    pageTemplate: HTMLTemplateElement;
  };
  // preview() resolves to the chunker; folios.js leaves the result on it.
  preview(
    html: string,
    css: string[],
    el: Element,
  ): Promise<{
    pageMapResult: RenderResult & { facts: Laid["facts"] };
    pagesArea: HTMLElement;
  }>;
}
declare const Paged: {
  Previewer: new (
    options: {
      pageMap: {
        seed: Seed;
        numbering: PageNumberingConfig;
        segment?: boolean;
      };
    },
  ) => Previewer;
  // A handler sees the render it's part of; its hooks are its methods.
  Handler: new (...args: never[]) => {
    chunker: { pagesArea: HTMLElement };
    polisher: {
      base: HTMLStyleElement;
      inserted: HTMLStyleElement[];
      styleEl: HTMLStyleElement;
    };
  };
  registerHandlers(...handlers: unknown[]): void;
};

// Each render's sheets apply to its own pages only (scope-css.ts), so the
// pages on screen keep their look while the next render is laid out. Done
// after parsing: Paged.js has put in the book's sheets and its generated
// rules, and laid nothing out or waited on a font yet. Its base sheet stays
// global; it is the same for every render, and its print rules need <body>.
let scoped = false;
function scopeRenders(): void {
  if (scoped) return;
  scoped = true;
  Paged.registerHandlers(
    class ScopeSheets extends Paged.Handler {
      afterParsed(): void {
        const root = this.chunker.pagesArea.parentElement!;
        root.dataset.scope ||= Math.random().toString(36).slice(2, 10);
        const scope = `[data-scope="${root.dataset.scope}"]`;
        const { base, inserted, styleEl } = this.polisher;
        for (const el of [...inserted, styleEl]) {
          if (el !== base && el.sheet) scopeSheet(el.sheet, scope);
        }
      }
    },
  );
}
// renderer/folios.js, imported by app.ts.
declare const BookPageMap: {
  settle(
    renderOnce: (seed: Seed) => Promise<RenderResult>,
    seed: Seed,
    maxPasses?: number,
  ): Promise<RenderResult & { passes: number }>;
  settleSegments(
    segments: Segment[],
    layOut: (s: Segment, seed: Seed) => Promise<Laid>,
    assembleAll: (laid: Laid[]) => RenderResult,
    seed: Seed,
  ): Promise<(RenderResult & { passes: number }) | null>;
  assemble(
    laid: Laid[],
    numbering: PageNumberingConfig,
    pagesArea: Element,
    pageTemplate: HTMLTemplateElement,
  ): RenderResult;
  replaceArea(live: Element, laid: Element): void;
  pageProblems(page: Element, n: number): PageProblem[];
};

export type UpdateMessage = Extract<ServerMessage, { type: "update" }>;

// Paged.js lays out one page per tick of its queue, and ticks on
// requestAnimationFrame — which a hidden tab never fires, so a book opened
// and then left in the background sat at "Setting type…" until it was
// looked at again. A message port isn't throttled in the background; the
// browser still paints between tasks, so pages appear as they are laid out.
const tickPort = new MessageChannel();
function renderTick(cb: () => void): void {
  tickPort.port1.onmessage = cb;
  tickPort.port2.postMessage(null);
}

/** The pages on screen, not a render being staged beside them. */
export const LIVE_PAGE = ":scope > :not(.preview-stage) .pagedjs_page";

let currentBlobUrl: string | null = null;
let rendering = false;
// Abandons the render under way: a newer update has made it pointless.
let cancelCurrent: (() => void) | null = null;
const CANCELLED = Symbol("render cancelled");
// Thrown by a segment's layout when the book must be laid out whole.
const WHOLE = Symbol("lay the book out whole");
// Rules Paged.js's Counters, target-counter() and target-text() handlers
// write for one run's elements (data-ref and the like, fresh each parse):
// pages laid by another run, or alone, don't match them.
const PER_RUN = /\[data-(?:ref|page-number|target-text|target-counter-[\w-]+)=/;
// What the render on screen or being produced for it is of (`target`); every
// accepted call sets it synchronously, so a queued render can't be skipped as
// "same".
let targetHash: string | null = null;
// The Previewer whose pages are on screen; its polisher owns their sheets.
let livePreviewer: Previewer | null = null;
// The sheets of a render with no Previewer of its own (restored from the
// cache, or every segment found there).
let restoredStyles: Element[] = [];
// The book's cache manifest as last saved or restored. A render of the book
// in the same styles takes its scope, so the sheets it names apply to the
// pages of the segments found in the cache.
let manifest: CachedRender | null = null;
// The on-screen render's anchor folios seed the next render, so it usually
// settles in one pass.
let seed: Seed = {};
let problems: PageProblem[] = [];
// The on-screen render's page map, for Inspect; [] when unknown.
let map: PageEntry[] = [];

/** The page map of the pages on screen: index = physical page − 1. */
export function pageMap(): PageEntry[] {
  return map;
}

/** Anchor id → refText of the pages on screen (cross-references). */
export function pageSeed(): Seed {
  return seed;
}
// The render for targetHash (in flight, queued or done); null after a restore.
let pending: Promise<PageProblem[]> | null = null;
let queuedUpdate: {
  update: UpdateMessage;
  container: HTMLElement;
  cacheKey: string | null;
  done: PromiseWithResolvers<PageProblem[]>;
} | null = null;

// The book's styles, each segment's key and the page numbering: two renders
// with the same target show the same pages.
function target(
  styles: string,
  keys: string[],
  numbering: PageNumberingConfig,
): string {
  return [styles, ...keys, JSON.stringify(numbering)].join(" ");
}

// Each update's segment keys, with the numbers each was keyed under: a
// segment's styles are hashed once, and its key again only when a number it
// prints changed.
const keyMemo = new WeakMap<
  UpdateMessage,
  Map<Segment, { style: string; read: string; key: string }>
>();

// A segment's cache key: its text, the styles that reach it, the numbers it
// prints.
function keyOf(u: UpdateMessage, s: Segment, from: Seed): string {
  let memo = keyMemo.get(u);
  if (!memo) keyMemo.set(u, memo = new Map());
  const read = s.reads.map((a) => from[a] ?? "000").join("\x1f");
  const was = memo.get(s);
  if (was?.read === read) return was.key;
  const style = was?.style ?? segmentStyleHash(s, u);
  const key = segmentKey(s, style, from, u.imageUrls);
  memo.set(s, { style, read, key });
  return key;
}

function targetOf(u: UpdateMessage, from: Seed): string {
  return target(
    styleHash(u),
    u.segments.map((s) => keyOf(u, s, from)),
    u.pageNumbering,
  );
}

/** Whether `render`'s pages are what rendering `u` would show. */
export function cacheHolds(render: CachedRender, u: UpdateMessage): boolean {
  return targetOf(u, render.seed) ===
    target(
      render.styleHash,
      render.segments.map((s) => s.key),
      render.pageNumbering,
    );
}

// A Previewer's sheets as text, in head order (the cascade's): its base
// sheet, the rules it generates, then the book CSS.
function sheetsOf(p: Previewer): string[] {
  const { styleEl, inserted } = p.polisher;
  return [...document.head.querySelectorAll("style")]
    .filter((el) => el === styleEl || inserted.includes(el))
    .map((el) =>
      [...el.sheet?.cssRules ?? []].map((r) => r.cssText).join("\n")
    );
}

function addStyles(styles: string[]): Element[] {
  return styles.map((css) => {
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  });
}

function templateOf(html: string): HTMLTemplateElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl;
}

// A cached segment's pages, its lines back in place and its images at this
// session's URLs. Parsed in a div, not a template, so the images load.
function pagesOf(
  row: CachedSegment,
  line: number,
  imageUrl: (name: string) => string,
): Element[] {
  const div = document.createElement("div");
  div.innerHTML = shiftLines(untokenImages(row.pages, imageUrl), line);
  return [...div.children];
}

// Each book-font link's load or failure, watched from when setFontLinks adds
// it: a link that has failed fires nothing more, so a listener added later
// would wait for good (offline, fonts blocked).
const linkSettled = new WeakMap<Element, Promise<unknown>>();

// The book's font stylesheets, loaded or failed: Paged.js waits only on the
// faces document.fonts already lists, and a link's join it once its sheet is
// in. Without this a first segment, laid out at once, set type in a fallback
// face.
function fontSheets(): Promise<unknown> {
  return Promise.all(
    [...document.querySelectorAll("link[data-book-font][rel=stylesheet]")]
      .map((l) => linkSettled.get(l)),
  );
}

// Resolves to the page-map problems of the render that ends up on screen.
// A null cacheKey renders without the cache (a theme preview, spec §7.5):
// every segment is laid out and nothing is saved.
export function renderPreview(
  update: UpdateMessage,
  container: HTMLElement,
  cacheKey: string | null,
): Promise<PageProblem[]> {
  const hash = targetOf(update, seed);
  // Same content as what's on screen or already on its way (e.g. the first
  // update after a restore): Paged.js would spend seconds reproducing it, so
  // share that render's outcome.
  if (hash === targetHash) return pending ?? Promise.resolve(problems);
  targetHash = hash;
  if (rendering) {
    // coalesce: only the latest pending update matters, and every caller
    // waiting on the queue gets its result. The render under way is for text
    // that no longer exists, so it stops here rather than running to the end.
    queuedUpdate = {
      update,
      container,
      cacheKey,
      done: queuedUpdate?.done ?? Promise.withResolvers(),
    };
    cancelCurrent?.();
    return pending = queuedUpdate.done.promise;
  }
  return pending = runRender(update, container, cacheKey);
}

// §4.16: an edit to a one-page section can't move another page.
interface OnePage {
  at: number;
  segment: Segment;
  key: string;
  was: string;
  page: HTMLElement;
  shift: { from: number; by: number } | null;
}
const ONE_SECTION = /^<article[^>]*><section [^>]*\bdata-one-page[ >]/;

function swappable(
  u: UpdateMessage,
  container: HTMLElement,
  book: CachedRender,
): OnePage | null {
  if (u.segments.length !== book.segments.length) return null;
  let at = -1;
  for (const [i, s] of u.segments.entries()) {
    if (keyOf(u, s, seed) === book.segments[i]!.key) continue;
    if (at !== -1) return null;
    at = i;
  }
  const segment = u.segments[at];
  if (
    !segment || !ONE_SECTION.test(segment.html) ||
    segment.html.match(/<section[ >]/g)?.length !== 1 ||
    !segment.html.endsWith("</section></article>")
  ) return null;
  const by = (u.segments[at + 1]?.line ?? 0) -
    (book.segments[at + 1]?.line ?? 0);
  const moved = u.segments.every((s, i) =>
    s.line - book.segments[i]!.line === (i > at ? by : 0)
  );
  const page = container.querySelector(
    `:scope > :not(.preview-stage) [id="${CSS.escape(segment.id)}"]`,
  )?.closest<HTMLElement>(".pagedjs_page");
  if (!moved || !page) return null;
  return {
    at,
    segment,
    key: keyOf(u, segment, seed),
    was: book.segments[at]!.key,
    page,
    shift: by ? { from: book.segments[at + 1]!.line, by } : null,
  };
}

// Same facts, so the same number, side and folio: only the text moves.
async function swapOnePage(
  u: UpdateMessage,
  container: HTMLElement,
  one: OnePage,
  book: CachedRender,
  cacheKey: string,
  tick: (cb: () => void) => void,
  cancelled: () => boolean,
): Promise<PageProblem[] | null> {
  const [old] = await Promise.all([loadCachedSegment(one.was), fontSheets()]);
  if (cancelled()) throw CANCELLED;
  if (!old || old.facts.length !== 1) return null;
  const css = [u.baseCss, u.domCss, u.pagedCss].join("\n");
  const blobUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
  // A stage's last page is hidden (app.css); this is its only page.
  const stage = document.createElement("div");
  stage.className = "preview-stage";
  stage.dataset.scope = book.scope;
  container.append(stage);
  const previewer = new Paged.Previewer({
    pageMap: { seed, numbering: u.pageNumbering, segment: true },
  });
  previewer.chunker.q.tick = tick;
  try {
    const flow = await previewer.preview(one.segment.html, [blobUrl], stage);
    if (cancelled()) throw CANCELLED;
    container.dataset.segmentsLaid = String(
      Number(container.dataset.segmentsLaid ?? 0) + 1,
    );
    const laid = [...flow.pagesArea.querySelectorAll(":scope > .pagedjs_page")];
    const { facts, problems: own } = flow.pageMapResult;
    if (
      laid.length !== 1 ||
      JSON.stringify(facts) !== JSON.stringify(old.facts) ||
      sheetsOf(previewer).join("\n") !== book.styles.join("\n")
    ) return null;
    const row: CachedSegment = {
      pages: tokenImages(
        shiftLines(laid[0]!.outerHTML, -one.segment.line),
        u.imageUrls,
      ),
      facts,
      problems: own,
    };
    const n = Number(one.page.dataset.pageNumber);
    const on = (list: PageProblem[]) =>
      list.map((p) => p.page === null ? p : { ...p, page: p.page - 1 + n });
    const gone = new Set(
      [...on(old.problems), ...BookPageMap.pageProblems(one.page, n)]
        .map((p) => JSON.stringify(p)),
    );
    BookPageMap.replaceArea(one.page, laid[0]!);
    if (one.shift) {
      const { from, by } = one.shift;
      for (
        const el of container.querySelectorAll<HTMLElement>(
          ":scope > :not(.preview-stage) [data-line]",
        )
      ) {
        const line = Number(el.dataset.line);
        if (line >= from) el.dataset.line = String(line + by);
      }
    }
    problems = [
      ...problems.filter((p) => !gone.has(JSON.stringify(p))),
      ...on(own),
      ...BookPageMap.pageProblems(one.page, n),
    ];
    const render: CachedRender = {
      ...book,
      problems,
      segments: u.segments.map((s) => ({
        key: keyOf(u, s, seed),
        line: s.line,
        opens: s.opens,
        ids: s.ids,
      })),
    };
    manifest = render;
    if (!queuedUpdate) targetHash = targetOf(u, seed);
    void saveCachedRender(cacheKey, render, new Map([[one.key, row]]));
    return problems;
  } finally {
    previewer.polisher.destroy(); // the live pages keep their own copies
    stage.remove();
    URL.revokeObjectURL(blobUrl);
  }
}

// Lays the book out a segment at a time (spec: segmented layout), each from
// the cache when its key is there, else by its own Previewer in its own stage,
// then assembles their pages into one .pagedjs_pages. One Previewer's sheets
// serve every page (all are scoped alike); the others' come down. When the
// segments' sheets differ, or hold rules for one run's elements (PER_RUN),
// the book is laid out whole, and nothing is saved.
async function runRender(
  update: UpdateMessage,
  container: HTMLElement,
  cacheKey: string | null,
): Promise<PageProblem[]> {
  rendering = true;
  // Cancelling rejects the race below and stops the queue ticking: Paged.js
  // finishes the page it is on and goes quiet, its promise dropped unsettled.
  let cancelled = false;
  const abort = Promise.withResolvers<never>();
  cancelCurrent = () => {
    cancelled = true;
    abort.reject(CANCELLED);
  };
  const tick = (cb: () => void) => {
    if (!cancelled) renderTick(cb);
  };
  scopeRenders();
  const sh = styleHash(update);
  // Same book CSS as the manifest's: its sheets and scope serve this render.
  const book = cacheKey !== null && manifest?.styleHash === sh
    ? manifest
    : null;
  // The keys on screen. With new CSS a cached segment needs this run's
  // sheets, so one segment is laid out regardless: the first whose key isn't
  // on screen (a style change reached it), or else the last.
  const shown = new Set(manifest?.segments.map((x) => x.key));
  const last = update.segments.at(-1);
  // `kept`: the first Previewer, whose sheets stay. `laying`: the one at
  // work. `copies`: the manifest's sheets, when every segment was cached.
  // `as`: keeps TS from narrowing these to null past the closures.
  let kept = null as { previewer: Previewer; styles: string[] } | null;
  let laying = null as Previewer | null;
  let whole = null as Previewer | null;
  let copies: Element[] = [];
  const keys = new Map<Segment, string>();
  const rows = new Map<string, CachedSegment>();
  try {
    const one = book && cacheKey !== null
      ? swappable(update, container, book)
      : null;
    if (one) {
      const swapped = await swapOnePage(
        update,
        container,
        one,
        book!,
        cacheKey!,
        tick,
        () => cancelled,
      ).catch((err) => err === CANCELLED ? CANCELLED : Promise.reject(err));
      if (swapped === CANCELLED) {
        return queuedUpdate ? queuedUpdate.done.promise : problems;
      }
      if (swapped) return swapped;
    }
    // The pages on screen keep their fonts until the swap drops them.
    setFontLinks(update.fontLinks, { keep: true });
    // pagedCss must go through the Previewer so Paged.js processes @page;
    // base + dom CSS ride along in the same sheet.
    const css = [update.baseCss, update.domCss, update.pagedCss].join("\n");
    const blobUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
    // Stage the new render invisibly next to the live pages, then swap — the
    // old pages stay on screen for the seconds Paged.js takes, no white flash.
    const stage = document.createElement("div");
    stage.className = "preview-stage";
    stage.dataset.scope = book?.scope ??
      Math.random().toString(36).slice(2, 10);
    // app.css keys the progress message and the dimming on this attribute,
    // not on :has(> .preview-stage): Chrome re-evaluates :has() on every
    // node Paged.js inserts, which made a re-render twenty times slower.
    container.dataset.rendering = container.childElementCount
      ? "again"
      : "first";
    container.appendChild(stage);
    const area = document.createElement("div");
    area.className = "pagedjs_pages";
    stage.append(area);
    const layOut = async (s: Segment, passSeed: Seed): Promise<Laid> => {
      if (cancelled) throw CANCELLED;
      const key = keyOf(update, s, passSeed);
      keys.set(s, key);
      const row = cacheKey !== null && await loadCachedSegment(key);
      if (cancelled) throw CANCELLED;
      if (row && (book || kept || (shown.has(key) && s !== last))) {
        const pages = pagesOf(row, s.line, (n) => update.imageUrls[n] ?? "");
        // Assembly checks each image's resolution.
        await Promise.all(
          pages.flatMap((p) => [...p.querySelectorAll("img")])
            .map((img) => img.decode().catch(() => {})),
        );
        if (cancelled) throw CANCELLED;
        const { facts, problems } = row;
        return { segment: s, pages, facts, problems, sheet: null };
      }
      // Scoped like the rest before Paged.js parses (ScopeSheets keeps it).
      const own = document.createElement("div");
      own.dataset.scope = stage.dataset.scope;
      stage.append(own);
      const previewer = laying = new Paged.Previewer({
        pageMap: {
          seed: passSeed,
          numbering: update.pageNumbering,
          segment: true,
        },
      });
      previewer.chunker.q.tick = tick;
      const flow = await previewer.preview(s.html, [blobUrl], own);
      laying = null;
      container.dataset.segmentsLaid = String(
        Number(container.dataset.segmentsLaid ?? 0) + 1,
      );
      const styles = sheetsOf(previewer);
      if (kept) previewer.polisher.destroy();
      else kept = { previewer, styles };
      if (styles.some((css) => PER_RUN.test(css))) throw WHOLE;
      const pages = [
        ...flow.pagesArea.querySelectorAll(":scope > .pagedjs_page"),
      ];
      const { facts, problems } = flow.pageMapResult;
      // As laid out alone: assembly renumbers and moves them next.
      if (cacheKey !== null) {
        rows.set(key, {
          pages: tokenImages(
            shiftLines(pages.map((p) => p.outerHTML).join(""), -s.line),
            update.imageUrls,
          ),
          facts,
          problems,
        });
      }
      return { segment: s, pages, facts, problems, sheet: styles.join("\n") };
    };
    const assembleAll = (laid: Laid[]): RenderResult => {
      // Every segment so far came from the cache, in the manifest's CSS: so
      // do the sheets.
      if (!kept && !copies.length) copies = addStyles(book!.styles);
      const r = BookPageMap.assemble(
        laid,
        update.pageNumbering,
        area,
        kept?.previewer.chunker.pageTemplate ?? templateOf(book!.pageTemplate),
      );
      area.style.setProperty("--pagedjs-page-count", String(r.map.length));
      return r;
    };
    let result: RenderResult & { passes: number } | null = null;
    try {
      await Promise.race([fontSheets(), abort.promise]);
      if (update.segments.length) {
        result = await Promise.race([
          BookPageMap.settleSegments(
            update.segments,
            layOut,
            assembleAll,
            seed,
          ).catch((err) => err === WHOLE ? null : Promise.reject(err)),
          abort.promise,
        ]);
      }
      if (!result) {
        kept?.previewer.polisher.destroy();
        kept = null;
        for (const el of copies) el.remove();
        copies = [];
        stage.replaceChildren();
        // Each pass renders into the stage; a pass that didn't settle leaves
        // its pages and sheets behind for the next one to clear.
        result = await Promise.race([
          BookPageMap.settle(async (passSeed) => {
            if (cancelled) throw CANCELLED; // no sheets for a pass nobody wants
            if (whole) {
              whole.polisher.destroy();
              stage.replaceChildren();
            }
            whole = new Paged.Previewer({
              pageMap: { seed: passSeed, numbering: update.pageNumbering },
            });
            whole.chunker.q.tick = tick;
            return (await whole.preview(update.html, [blobUrl], stage))
              .pageMapResult;
          }, seed),
          abort.promise,
        ]);
      }
    } catch (err) {
      for (const p of [laying, kept?.previewer, whole]) p?.polisher.destroy();
      for (const el of copies) el.remove();
      stage.remove();
      URL.revokeObjectURL(blobUrl);
      // Whoever waited on this render gets the outcome of the one replacing it.
      if (err === CANCELLED && queuedUpdate) return queuedUpdate.done.promise;
      if (err === CANCELLED) return problems; // a restore took the screen
      throw err;
    }
    // A copy: removing from the live collection would skip every other one.
    for (const old of [...container.children]) if (old !== stage) old.remove();
    // The segments' own stages: their pages are in the area now.
    if (!whole) {
      for (const el of [...stage.children]) if (el !== area) el.remove();
    }
    // The old sheets and fonts belong to the pages that just went away.
    livePreviewer?.polisher.destroy();
    for (const el of restoredStyles) el.remove();
    restoredStyles = [];
    if (kept) { for (const el of copies) el.remove(); }
    else restoredStyles = copies;
    setFontLinks(update.fontLinks);
    livePreviewer = kept?.previewer ?? whole;
    stage.className = "";
    fitPreview(container);
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = blobUrl;
    ({ seed, problems, map } = result);
    // The pages on screen, named under the seed they settled on.
    if (!queuedUpdate) targetHash = targetOf(update, seed);
    if (cacheKey !== null && !whole) {
      const render: CachedRender = {
        styleHash: sh,
        scope: stage.dataset.scope!,
        styles: kept?.styles ?? book!.styles,
        pageTemplate: kept?.previewer.chunker.pageTemplate.innerHTML ??
          book!.pageTemplate,
        fontLinks: update.fontLinks,
        pageNumbering: update.pageNumbering,
        seed,
        problems,
        segments: update.segments.map((s) => ({
          key: keys.get(s)!,
          line: s.line,
          opens: s.opens,
          ids: s.ids,
        })),
      };
      manifest = render;
      const named = new Set(render.segments.map((s) => s.key));
      void saveCachedRender(
        cacheKey,
        render,
        new Map([...rows].filter(([k]) => named.has(k))),
      ); // fire-and-forget: never throws, and the render shouldn't wait on it
    }
    return problems;
  } finally {
    rendering = false;
    cancelCurrent = null;
    delete container.dataset.rendering;
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

/** A book's cached render, with this session's URL for each image it shows. */
export interface CachedBook {
  render: CachedRender;
  segments: CachedSegment[];
  imageUrl(name: string): string;
}

// Drops the render under way or queued and the sheets of the pages on screen;
// returns the queued render's waiters, for the caller to answer.
function dropScreen(): PromiseWithResolvers<PageProblem[]> | undefined {
  const dropped = queuedUpdate;
  queuedUpdate = null;
  cancelCurrent?.();
  livePreviewer?.polisher.destroy();
  livePreviewer = null;
  for (const el of restoredStyles) el.remove();
  restoredStyles = [];
  pending = null;
  return dropped?.done;
}

// Put a cached render on screen without Paged.js: every segment's pages,
// assembled, plus the sheets Paged.js had inserted for them. targetHash is set
// so the first WebSocket update, which carries the same content, is skipped.
// A render under way or queued is dropped, and the sheets of the pages it
// replaces come down. `imageUrl`: this session's URL for an image file.
export function restoreCachedRender(
  cached: { render: CachedRender; segments: CachedSegment[] },
  container: HTMLElement,
  imageUrl: (name: string) => string,
): void {
  const { render } = cached;
  const dropped = dropScreen();
  setFontLinks(render.fontLinks);
  restoredStyles = addStyles(render.styles);
  const root = document.createElement("div");
  root.dataset.scope = render.scope;
  const area = document.createElement("div");
  area.className = "pagedjs_pages";
  root.append(area);
  container.replaceChildren(root);
  const laid = render.segments.map((s, i): Laid => {
    const row = cached.segments[i]!;
    return {
      segment: { ...s, id: s.key, html: "", reads: [] },
      pages: pagesOf(row, s.line, imageUrl),
      facts: row.facts,
      problems: row.problems,
      sheet: null,
    };
  });
  const r = BookPageMap.assemble(
    laid,
    render.pageNumbering,
    area,
    templateOf(render.pageTemplate),
  );
  area.style.setProperty("--pagedjs-page-count", String(r.map.length));
  manifest = render;
  targetHash = target(
    render.styleHash,
    render.segments.map((s) => s.key),
    render.pageNumbering,
  );
  // The saved problems: these images haven't loaded, so assembly can't
  // judge them.
  ({ seed, problems } = render);
  map = r.map;
  fitPreview(container);
  dropped?.resolve(problems);
}

/** No pages: nothing to show until the next render. */
export function clearPreview(container: HTMLElement): void {
  const dropped = dropScreen();
  container.replaceChildren();
  targetHash = null;
  seed = {};
  problems = [];
  map = [];
  dropped?.resolve(problems);
}

// The book's font links, as `html` lists them. A link already in the page
// stays put rather than load again; `keep` leaves the ones `html` doesn't list.
export function setFontLinks(html: string, { keep = false } = {}): void {
  const key = (l: Element) =>
    `${l.getAttribute("rel")} ${l.getAttribute("href")}`;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const want = new Map(
    [...tpl.content.querySelectorAll("link")].map((l) => [key(l), l]),
  );
  for (const el of document.querySelectorAll("link[data-book-font]")) {
    if (!want.delete(key(el)) && !keep) el.remove();
  }
  for (const link of want.values()) {
    link.setAttribute("data-book-font", "");
    linkSettled.set(
      link,
      new Promise((done) => {
        link.addEventListener("load", done, { once: true });
        link.addEventListener("error", done, { once: true });
      }),
    );
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

// Follow the cursor (spec §7.3): outline the rendered block the editor's line
// is part of — the nearest `data-line` at or above it, every fragment of it
// when a page break splits it — and keep it in view. null clears the outline.
export function markEdited(container: HTMLElement, line: number | null): void {
  for (const el of container.querySelectorAll("[data-edit-hl]")) {
    el.removeAttribute("data-edit-hl");
  }
  if (line === null) return;
  const live = [...container.querySelectorAll("[data-line]")].filter((el) =>
    !el.closest(".preview-stage")
  );
  const at = (el: Element) => Number(el.getAttribute("data-line"));
  const best = Math.max(0, ...live.map(at).filter((n) => n <= line));
  if (!best) return;
  const hits = live.filter((el) => at(el) === best);
  for (const el of hits) el.setAttribute("data-edit-hl", "");
  // By hand, not scrollIntoView: the pages are CSS-zoomed (fitPreview), and
  // Chrome scrolls a zoomed element to the wrong place.
  const r = hits[0]?.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  if (!r) return;
  if (r.top < c.top || r.height > c.height) {
    container.scrollTop += r.top - c.top - 24;
  } else if (r.bottom > c.bottom) {
    container.scrollTop += r.bottom - c.bottom + 24;
  }
}

// The app's mode (spec §7.1): what the middle column edits.
export type Mode = "write" | "style" | "publish";

// The stylable node at or above `target` and its catalog key: matchKey picks
// the entry from the target's class+tag chain, closest() finds the node its
// selector matched. Nothing inside a staged (half-rendered) preview. Page
// furniture (folios, running heads) has no source line, so it always styles.
// Inspect (inspect.ts) names what it points at the same way.
export function resolveStyle(
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
// block's data-line), and on an empty illustration placeholder then to
// `addImage` with its slug (no file: the app opens the picker). A file dropped
// on a placeholder in Write goes to `addImage` too (spec §7.6). Furniture
// always goes to its style. A styled node is outlined until the next pick or
// re-render; consumed clicks don't let the TOC's links navigate. `catalog` is
// read per click — `is:` entries change with the metadata. While Inspect is on
// (`inspecting`), clicks are its own and nothing here runs.
export function installPreviewClicks(
  container: HTMLElement,
  catalog: () => StyleEntry[],
  on: {
    mode(): Mode;
    style(key: string): void;
    source(line: number): void;
    addImage?(slug: string, file?: File): void;
    inspecting(): boolean;
  },
): void {
  // The slug of the live placeholder at or above `target`, in Write only.
  const placeholder = (target: EventTarget | null) => {
    if (on.mode() !== "write" || !(target instanceof Element)) return;
    if (target.closest(".preview-stage")) return;
    return target.closest<HTMLElement>(".illustration-placeholder")?.dataset
      .slug;
  };
  container.addEventListener("dragover", (e) => {
    if (!on.addImage || !placeholder(e.target)) return;
    if (![...e.dataTransfer?.types ?? []].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  });
  container.addEventListener("drop", (e) => {
    const slug = placeholder(e.target);
    const file = e.dataTransfer?.files[0];
    if (!on.addImage || !slug || !file) return;
    e.preventDefault();
    on.addImage(slug, file);
  });
  container.addEventListener("click", (e) => {
    if (on.inspecting()) return;
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
    const slug = placeholder(target);
    if (slug) on.addImage?.(slug);
  });
}

// Hover outline (spec R3): the node a click would style, once per frame —
// everywhere in Style, only furniture in Write; nothing while Inspect is on.
// A re-render replaces the nodes, which takes the attribute with them.
export function installStyleHover(
  container: HTMLElement,
  catalog: () => StyleEntry[],
  mode: () => Mode,
  inspecting: () => boolean,
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
      const hit = inspecting()
        ? null
        : resolveStyle(pointed, container, catalog());
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
export function marginShows(box: Element): boolean {
  const inner = box.querySelector(".pagedjs_margin-content");
  if (!inner || !box.classList.contains("hasContent")) return false;
  const content = getComputedStyle(inner, "::after").content;
  return content !== "none" && content !== "normal" &&
    content.replace(/["\s]/g, "") !== "";
}

// Where each printed page begins in the manuscript (design-language.md §8.1
// page turns), 1-based lines, read from the live pages of the last layout.
// `page` is its printed folio ("vii", "12"), as numbered even when hidden.
export interface PageTurn {
  line: number;
  page: string;
}
export function pageTurns(container: HTMLElement): PageTurn[] {
  const out: PageTurn[] = [];
  let last = 0;
  for (
    const p of container.querySelectorAll<HTMLElement>(
      ":scope > :not(.preview-stage) .pagedjs_page",
    )
  ) {
    // The first leaf block on the page: a section's own data-line is its
    // opening, not where this page starts. A block split across pages keeps
    // its data-line on the continuation, so the turn lands on that block.
    // ponytail: block granularity, not the exact line where the page breaks.
    const line = Number(
      p.querySelector("[data-line]:not(:has([data-line]))")
        ?.getAttribute("data-line"),
    );
    const page = p.dataset.folio;
    // One turn per line: the first page that begins in it.
    if (!(line > last)) continue;
    last = line;
    if (page) out.push({ line, page });
  }
  return out;
}

// The live pages and the index of the one nearest the pane's vertical centre
// (the first of a spread, on a tie); -1 when there are none.
function nearestPage(
  container: HTMLElement,
): { pages: HTMLElement[]; at: number } {
  const pages = [...container.querySelectorAll<HTMLElement>(LIVE_PAGE)];
  const mid = container.getBoundingClientRect().top +
    container.clientHeight / 2;
  let at = -1;
  let bestDist = Infinity;
  pages.forEach((p, i) => {
    const r = p.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestDist) [at, bestDist] = [i, d];
  });
  return { pages, at };
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
    const { pages, at } = nearestPage(container);
    out.textContent = pages[at]
      ? `Page ${pages[at].dataset.pageNumber ?? "?"} of ${pages.length}`
      : "";
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  container.addEventListener("scroll", schedule, { passive: true });
  return schedule;
}

// Where a chapter or part begins: the fragment with its id, not a split
// continuation (folios.js's `opener`).
const OPENER = ".chapter:not([data-split-from]), .part:not([data-split-from])";

// The next or previous page, or page holding a chapter or part opening, from
// the one the indicator names. Pages sit in spreads, so a step leaves the
// current row: next page from a spread is the next spread.
export function stepPreview(
  container: HTMLElement,
  dir: 1 | -1,
  unit: "page" | "chapter",
): void {
  const { pages, at } = nearestPage(container);
  const here = pages[at];
  if (!here) return;
  const top = here.offsetTop;
  let i = at;
  while (pages[i]?.offsetTop === top) i += dir;
  if (unit === "chapter") {
    while (pages[i] && !pages[i]!.querySelector(OPENER)) i += dir;
  }
  const p = pages[i];
  if (!p) return;
  // By hand, not scrollIntoView (see markEdited). A page shorter than the
  // pane is centred, so it is the one the indicator then names; a taller one
  // shows its top.
  const r = p.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  const h = container.clientHeight;
  container.scrollTop += r.top - c.top -
    (r.height < h ? (h - r.height) / 2 : 16);
}

// Fit a full spread (two pages + gap) to the pane width via CSS zoom, never
// upscaling past 1:1. Called after each render and on pane resize. This is
// 100%; the reader's zoom (preview-zoom.ts, --preview-user) multiplies it.
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
  // zoom survives re-renders and pages don't flash at 1:1 mid-render. app.css
  // applies it to the live pages, and to each finished page of a staged render.
  container.style.setProperty("--preview-fit", k.toFixed(3));
}

// The book's paper stock (`page.paper`, design-language.md §2.5) on the live
// pages only: print clears the page background, so sheets and PDFs stay white.
// A value that isn't a color leaves the default stock, not a see-through page.
export function setPaperStock(color: string | undefined): void {
  const preview = document.getElementById("preview")!;
  if (color && CSS.supports("color", color)) {
    preview.style.setProperty("--stock", color);
  } else preview.style.removeProperty("--stock");
}
