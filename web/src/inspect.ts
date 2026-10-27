// web/src/inspect.ts — Inspect (spec §7.6, design-language.md §2.4): the
// pages header's picker. While it is on, pointing at the pages names what is
// there and how big it is; a click pins it; ⌥ measures from the pinned thing
// to the pointed one; running heads and page numbers the page map dropped
// show as ghosts. It reads the live pages and never writes to them: its marks
// are drawn in their own layer (#inspect-overlay, a sibling of #preview), so
// print.ts, which clones the pages, never carries any of it.
import type { Metadata } from "../../metadata/types.ts";
import type { PageEntry } from "../../renderer/page-map-types.ts";
import { marginShows, type Mode, resolveStyle } from "./preview.ts";
import type { StyleEntry } from "./style-catalog.ts";
import {
  type Line,
  measureLines,
  nameOf,
  renderDrawer,
  spaceRect,
  unitFor,
  zoomOf,
} from "./inspect-drawer.ts";
import {
  bookLength,
  faceOf,
  gaps,
  type Pinned,
  points,
} from "./inspect-facts.ts";

export interface Target {
  kind: Pinned;
  /** The block, span or margin box; the block a line is in; null for space. */
  el: Element | null;
  page: Element;
  /** For kind "line": its number in the block, from 1. */
  line: number | null;
  entry: StyleEntry | null;
}

const LIVE_PAGE = ":scope > :not(.preview-stage) .pagedjs_page";
// Spans a click pins apart from their block.
const SPAN = "em, a.ref, .dropcap, .footnote-anchor";

type Rect = { top: number; bottom: number; left: number; right: number };
const within = (r: Rect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

export function installInspect(deps: {
  container: HTMLElement;
  catalog(): StyleEntry[];
  metadata(): Metadata;
  pageMap(): PageEntry[];
  mode(): Mode;
  style(key: string): void;
  source(line: number): void;
}): { active(): boolean; escape(): boolean } {
  const { container } = deps;
  const button = document.getElementById("inspect")!;
  const host = document.getElementById("inspect-overlay")!;
  const drawer = document.getElementById("inspect-drawer")!;
  let on = false;
  let pinned: Target | null = null;
  let hover: Target | null = null;
  let alt = false;

  const active = () => on && deps.mode() !== "publish";
  const livePages = () => [...container.querySelectorAll(LIVE_PAGE)];
  const entryAt = (page: Element) => deps.pageMap()[livePages().indexOf(page)];

  // Running heads and page numbers the page map dropped on this page: the
  // margin box is there (its @page area has content), it shows nothing.
  const ghosts = (page: Element): Target[] => {
    const e = entryAt(page);
    if (!e) return [];
    const out: Target[] = [];
    const seen = new Set<Element>();
    for (const entry of deps.catalog()) {
      const head = entry.section === "running";
      if (!head && entry.key !== "numbering.pages") continue;
      if (head ? e.head : e.folioText !== "") continue;
      for (const box of page.querySelectorAll(entry.selector)) {
        if (seen.has(box) || !box.classList.contains("hasContent")) continue;
        seen.add(box);
        if (!marginShows(box)) {
          out.push({ kind: "ghost", el: box, page, line: null, entry });
        }
      }
    }
    return out;
  };

  // An empty margin box has no width, so a ghost borrows the place its area's
  // text takes on the first page that prints it. Kept until the pages change.
  const donors = new Map<string, Rect | null>();
  const ghostRect = (t: Target): Rect => {
    const box = t.el!;
    const area =
      [...box.classList].find((c) => c.startsWith("pagedjs_margin-")) ?? "";
    if (!donors.has(area)) {
      donors.set(area, null);
      for (const page of livePages()) {
        const shown = page.querySelector(`.${area}`);
        const text = shown?.querySelector(".pagedjs_margin-content");
        if (!shown || !text || !marginShows(shown)) continue;
        const p = page.getBoundingClientRect();
        const r = text.getBoundingClientRect();
        const z = zoomOf(page);
        donors.set(area, {
          left: (r.left - p.left) / z,
          right: (r.right - p.left) / z,
          top: (r.top - p.top) / z,
          bottom: (r.bottom - p.top) / z,
        });
        break;
      }
    }
    const d = donors.get(area);
    const p = t.page.getBoundingClientRect();
    if (d) {
      const z = zoomOf(t.page);
      // A line of small type is a thin target: a little room around it.
      return {
        left: p.left + d.left * z - 2,
        right: p.left + d.right * z + 2,
        top: p.top + d.top * z - 2,
        bottom: p.top + d.bottom * z + 2,
      };
    }
    const r = box.getBoundingClientRect();
    const w = Math.max(r.width, p.width / 4) / 2;
    const mid = r.left + r.width / 2;
    return { left: mid - w, right: mid + w, top: r.top, bottom: r.bottom };
  };

  // What the pointer is on: a ghost, a span clicked directly, the styled
  // block, printed furniture, or the empty space below the last block.
  const targetAt = (el: Element | null, x: number, y: number) => {
    const page = el?.closest(".pagedjs_page");
    if (!el || !page || page.closest(".preview-stage")) return null;
    for (const g of ghosts(page)) if (within(ghostRect(g), x, y)) return g;
    const catalog = deps.catalog();
    const at = (node: Element | null) => {
      const hit = resolveStyle(node, container, catalog);
      return hit
        ? { ...hit, entry: catalog.find((e) => e.key === hit.key) }
        : null;
    };
    const span = el.closest(SPAN);
    if (span && page.contains(span)) {
      return {
        kind: "span" as const,
        el: span,
        page,
        line: null,
        entry: at(span)?.entry ?? null,
      };
    }
    const hit = at(el);
    if (hit?.entry && hit.furniture) {
      return marginShows(hit.el)
        ? {
          kind: "furniture" as const,
          el: hit.el,
          page,
          line: null,
          entry: hit.entry,
        }
        : null;
    }
    if (hit?.entry && hit.key !== "body") {
      return {
        kind: "block" as const,
        el: hit.el,
        page,
        line: null,
        entry: hit.entry,
      };
    }
    const space = spaceRect(page);
    return space && within(space, x, y)
      ? { kind: "space" as const, el: null, page, line: null, entry: null }
      : null;
  };

  const rectsOf = (t: Target): Rect[] => {
    if (t.kind === "ghost") return [ghostRect(t)];
    if (t.kind === "space") {
      const r = spaceRect(t.page);
      return r ? [r] : [];
    }
    if (t.kind === "span") return [...t.el!.getClientRects()];
    if (t.kind === "line") {
      const l = linesOf(t.el!, t.page)[(t.line ?? 1) - 1];
      return l ? [l] : [];
    }
    return [t.el!.getBoundingClientRect()];
  };

  // The pinned block's lines, measured once per block and zoom and moved
  // with its page as the pane scrolls.
  let measured: {
    block: Element;
    z: number;
    left: number;
    top: number;
    lines: Line[];
  } | null = null;
  const linesOf = (block: Element, page: Element): Line[] => {
    const p = page.getBoundingClientRect();
    const z = zoomOf(page);
    if (measured?.block !== block || measured.z !== z) {
      measured = {
        block,
        z,
        left: p.left,
        top: p.top,
        lines: measureLines(block),
      };
    }
    const dx = p.left - measured.left;
    const dy = p.top - measured.top;
    return measured.lines.map((l) => ({
      ...l,
      left: l.left + dx,
      right: l.right + dx,
      top: l.top + dy,
      bottom: l.bottom + dy,
      baseline: l.baseline + dy,
    }));
  };
  const union = (rs: Rect[]): Rect | null =>
    rs.length
      ? {
        top: Math.min(...rs.map((r) => r.top)),
        bottom: Math.max(...rs.map((r) => r.bottom)),
        left: Math.min(...rs.map((r) => r.left)),
        right: Math.max(...rs.map((r) => r.right)),
      }
      : null;
  const same = (a: Target | null, b: Target | null) =>
    !!a && !!b && a.kind === b.kind && a.el === b.el && a.page === b.page &&
    a.line === b.line;

  // ---- drawing: the layer is rebuilt whole, once a frame at most ----

  let frame = 0;
  const schedule = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  const draw = () => {
    host.hidden = !active();
    if (host.hidden) return host.replaceChildren();
    // Over #preview's visible box, so the marks clip where the pages do.
    host.style.left = `${container.offsetLeft + container.clientLeft}px`;
    host.style.top = `${container.offsetTop + container.clientTop}px`;
    host.style.width = `${container.clientWidth}px`;
    host.style.height = `${container.clientHeight}px`;
    const h = host.getBoundingClientRect();
    const marks: HTMLElement[] = [];
    const mark = (cls: string, r: Rect) => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.left = `${r.left - h.left}px`;
      d.style.top = `${r.top - h.top}px`;
      d.style.width = `${r.right - r.left}px`;
      d.style.height = `${r.bottom - r.top}px`;
      marks.push(d);
      return d;
    };
    const unit = unitFor(deps.metadata());

    for (const page of livePages()) {
      const p = page.getBoundingClientRect();
      if (p.bottom < h.top || p.top > h.bottom) continue;
      for (const g of ghosts(page)) mark("ghost", ghostRect(g));
    }

    const hovered = same(hover, pinned) ? null : hover;
    if (hovered) {
      if (hovered.kind === "block") shade(hovered.el!, hovered.page, mark);
      else for (const r of rectsOf(hovered)) mark("content", r);
      for (const r of rectsOf(hovered)) mark("ring", r);
      tag(hovered, unit, h, marks);
    }
    if (pinned?.kind === "line") {
      // Every line's baseline, the pinned one's strong, and where the
      // browser hyphenated it.
      const lines = linesOf(pinned.el!, pinned.page);
      lines.forEach((l, i) => {
        const on = i + 1 === pinned!.line;
        mark(on ? "base on" : "base", {
          ...l,
          top: l.baseline,
          bottom: l.baseline + 1,
        });
        if (on && l.hyphenated) {
          const w = (l.bottom - l.top) / 3;
          mark("hyphen", { ...l, left: l.right, right: l.right + w });
        }
      });
    }
    if (pinned) {
      for (const r of rectsOf(pinned)) mark("ring pin", r);
      if (pinned.kind === "span" || pinned.kind === "line") {
        const block = pinned.kind === "span"
          ? pinned.el!.closest("[data-line]")
          : pinned.el;
        if (block) mark("ring within", block.getBoundingClientRect());
      }
    }
    if (alt && pinned && hovered) {
      const a = union(rectsOf(pinned));
      const b = union(rectsOf(hovered));
      const z = zoomOf(hovered.page);
      for (const g of a && b ? gaps(a, b) : []) {
        const y = g.axis === "y";
        const line = y
          ? { left: g.at, right: g.at + 1, top: g.from, bottom: g.to }
          : { left: g.from, right: g.to, top: g.at, bottom: g.at + 1 };
        mark(`gap ${g.axis}`, line);
        const pill = mark("pill", {
          left: y ? g.at : (g.from + g.to) / 2,
          top: y ? (g.from + g.to) / 2 : g.at,
          right: y ? g.at : (g.from + g.to) / 2,
          bottom: y ? (g.from + g.to) / 2 : g.at,
        });
        pill.style.width = pill.style.height = "";
        pill.textContent = `${bookLength((g.to - g.from) / z, unit)} ${unit}`;
      }
    }
    host.replaceChildren(...marks);
  };

  // Box-model shading (as DevTools does): the space above and below in amber,
  // the first-line indent in green, the content in light blue. Computed
  // lengths are unzoomed; the page's zoom scales them onto the screen.
  const shade = (
    el: Element,
    page: Element,
    mark: (cls: string, r: Rect) => HTMLElement,
  ) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const z = zoomOf(page);
    const px = (v: string) => (parseFloat(v) || 0) * z;
    const above = px(cs.marginTop);
    const below = px(cs.marginBottom);
    if (above > 0) {
      mark("space", { ...r.toJSON(), top: r.top - above, bottom: r.top });
    }
    if (below > 0) {
      mark("space", { ...r.toJSON(), top: r.bottom, bottom: r.bottom + below });
    }
    mark("content", r);
    const indent = px(cs.textIndent);
    if (indent > 0) {
      const left = r.left + px(cs.paddingLeft);
      const top = r.top + px(cs.paddingTop);
      const line = px(cs.lineHeight) || 1.2 * px(cs.fontSize);
      mark("indent", {
        left,
        right: left + indent,
        top,
        bottom: top + line,
      });
    }
  };

  // The hover tag: name and size, then face and size of type. Above the
  // target when there's room in the pane, else below; kept inside it.
  const tag = (
    t: Target,
    unit: "in" | "mm",
    h: DOMRect,
    marks: HTMLElement[],
  ) => {
    const r = union(rectsOf(t));
    if (!r) return;
    const z = zoomOf(t.page);
    const d = document.createElement("div");
    d.className = "tag";
    const name = document.createElement("b");
    name.textContent = nameOf(t, deps.catalog());
    const size = document.createElement("span");
    size.textContent = ` ${bookLength((r.right - r.left) / z, unit)} × ${
      bookLength((r.bottom - r.top) / z, unit)
    } ${unit}`;
    d.append(name, size);
    const type = t.el && t.kind !== "ghost"
      ? t.el.querySelector(".pagedjs_margin-content") ?? t.el
      : null;
    if (type) {
      const cs = getComputedStyle(type);
      const line = document.createElement("div");
      line.textContent = `${faceOf(cs.fontFamily)} ${
        points(parseFloat(cs.fontSize))
      } pt`;
      d.append(line);
    }
    const up = r.top - h.top > 48;
    d.style.left = `${Math.max(0, Math.min(r.left - h.left, h.width - 240))}px`;
    d.style.top = `${(up ? r.top : r.bottom) - h.top}px`;
    d.classList.toggle("up", up);
    marks.push(d);
  };

  // ---- pinning ----

  const pin = (t: Target | null) => {
    pinned = t;
    showDrawer();
    schedule();
  };
  const showDrawer = () =>
    renderDrawer(drawer, active() ? pinned : null, { ...deps, pin });

  // After a re-render the pinned node is gone; the same block (by its
  // manuscript line and entry) is pinned again if it's still there.
  const repin = () => {
    if (!pinned || pinned.page.isConnected) return;
    const t = pinned;
    const block = t.kind === "span" ? t.el?.closest("[data-line]") : t.el;
    const line = block?.getAttribute("data-line");
    const pageIdx = Number(t.page.getAttribute("data-page-number")) - 1;
    pinned = null;
    if (
      !line || !(t.kind === "block" || t.kind === "line" || t.kind === "span")
    ) {
      return;
    }
    const spanIdx = t.kind === "span"
      ? [...block!.querySelectorAll(SPAN)].indexOf(t.el!)
      : -1;
    const sel = t.kind === "span" || !t.entry
      ? "[data-line]"
      : t.entry.selector;
    const found = [...container.querySelectorAll(`[data-line="${line}"]`)]
      .filter((el) => !el.closest(".preview-stage") && el.matches(sel));
    const pages = livePages();
    const el =
      found.find((el) =>
        pages.indexOf(el.closest(".pagedjs_page")!) === pageIdx
      ) ?? found[0];
    const page = el?.closest(".pagedjs_page");
    if (!el || !page) return;
    if (t.kind !== "span") {
      pinned = { ...t, el, page };
      return;
    }
    const span = el.querySelectorAll(SPAN)[spanIdx];
    if (span) pinned = { ...t, el: span, page };
  };

  // ---- events ----

  const setOn = (v: boolean) => {
    on = v;
    button.setAttribute("aria-pressed", String(v));
    container.toggleAttribute("data-inspect", v);
    hover = null;
    if (!v) pin(null);
    schedule();
  };
  button.addEventListener("click", () => setOn(!on));

  let pointed: { el: Element | null; x: number; y: number } | null = null;
  let raf = 0;
  container.addEventListener("mousemove", (e) => {
    if (!active()) return;
    pointed = { el: e.target as Element | null, x: e.clientX, y: e.clientY };
    alt = e.altKey;
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      hover = pointed && targetAt(pointed.el, pointed.x, pointed.y);
      draw();
    });
  }, { passive: true });
  container.addEventListener("mouseleave", () => {
    cancelAnimationFrame(raf);
    raf = 0;
    hover = null;
    schedule();
  });
  container.addEventListener("click", (e) => {
    if (!active()) return;
    e.preventDefault(); // the contents' links don't navigate
    const el = e.target as Element | null;
    const t = targetAt(el, e.clientX, e.clientY);
    if (t) pin(t);
    else if (!el?.closest(".pagedjs_page")) pin(null); // the desk
  });
  container.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(container);
  // A render swapping the pages (children of #preview), a zoom or fit (its
  // style), the mode: redraw. The pages changing also re-finds the pin.
  new MutationObserver((records) => {
    if (records.some((r) => r.type === "childList")) {
      donors.clear();
      hover = null;
      if (pinned && !pinned.page.isConnected) {
        repin();
        showDrawer();
      }
    }
    schedule();
  }).observe(container, { childList: true, attributes: true });
  // A face arriving late reflows the pages with no mutation to see: redraw,
  // and measure the pinned block's lines again.
  document.fonts.addEventListener("loadingdone", () => {
    measured = null;
    showDrawer();
    schedule();
  });
  new MutationObserver(() => {
    showDrawer();
    schedule();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode"],
  });

  return {
    active,
    // Esc unpins, then leaves Inspect; false when there was nothing to undo.
    escape() {
      if (!active()) return false;
      if (pinned) pin(null);
      else setOn(false);
      return true;
    },
  };
}
