// web/src/inspect-drawer.ts — Inspect's drawer under the pages (spec §7.6,
// design-language.md §6.13): for the pinned target, where it sits (a
// breadcrumb), why it's there, its box and its type, its lines, and the way
// to its source and its style. It reads the live pages and the page map; the
// wording of the reasons is inspect-facts.ts's.
import type { Metadata } from "../../metadata/types.ts";
import {
  DEFAULT_SIZE,
  fmtLength,
  type Unit,
  unitOf,
} from "../../metadata/page-setup.ts";
import type { PageEntry } from "../../renderer/page-map-types.ts";
import type { Target } from "./inspect.ts";
import { h } from "./panel-controls.ts";
import { pageSeed, resolveStyle } from "./preview.ts";
import {
  entryName,
  sourceOf,
  type StyleEntry,
  type ValueSource,
} from "./style-catalog.ts";
import {
  endsMidWord,
  faceOf,
  groupLines,
  type InspectFacts,
  points,
  reasonsFor,
} from "./inspect-facts.ts";

type Rect = { top: number; bottom: number; left: number; right: number };

/** On-screen px per unzoomed CSS px on this page: fit × the reader's zoom. */
export function zoomOf(page: Element): number {
  return page.getBoundingClientRect().width /
    (parseFloat(getComputedStyle(page).width) || 1);
}

/** The book's unit for lengths: mm when its page size is metric. */
export function unitFor(metadata: Metadata): Unit {
  return unitOf(metadata.page?.size ?? DEFAULT_SIZE);
}

/** What Inspect calls a target. */
export function nameOf(t: Target, catalog: StyleEntry[]): string {
  if (t.kind === "space") return "Empty space";
  if (t.kind === "line") return `Line ${t.line}`;
  if (t.el?.matches("a.ref")) return "Cross-reference";
  if (t.el?.matches(".footnote-anchor")) return "Footnote reference";
  const name = t.entry ? entryName(t.entry, catalog) : "";
  return t.kind === "ghost" ? `${name} (not printed)` : name;
}

/**
 * The text block below the page's last block, when at least a line of it is
 * left: why the page is short. Null on a full page.
 */
export function spaceRect(page: Element): Rect | null {
  const content = page.querySelector(".pagedjs_page_content");
  const leaves = [...page.querySelectorAll("[data-line]")].filter((el) =>
    !el.querySelector("[data-line]")
  );
  const last = leaves.at(-1);
  if (!content || !last) return null;
  const c = content.getBoundingClientRect();
  const top = Math.max(
    ...leaves.map((el) => el.getBoundingClientRect().bottom),
  );
  const cs = getComputedStyle(last);
  const line = (parseFloat(cs.lineHeight) || 1.2 * parseFloat(cs.fontSize)) *
    zoomOf(page);
  return c.bottom - top < line
    ? null
    : { left: c.left, right: c.right, top, bottom: c.bottom };
}

export interface Line extends Rect {
  /** Where the line's text sits, between top and bottom. */
  baseline: number;
  hyphenated: boolean;
}

let canvas: CanvasRenderingContext2D | null = null;

/**
 * The block's lines as laid out: its text's rects grouped by height (a drop
 * cap, which spans lines, left out), each widened to the block's leading, its
 * baseline from the font's own ascent and descent, and whether the browser
 * broke a word at its end. Only ever for the pinned block.
 */
export function measureLines(block: Element): Line[] {
  const range = document.createRange();
  const texts: Text[] = [];
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.parentElement?.closest(".dropcap")) texts.push(n as Text);
  }
  const rects: Rect[] = [];
  for (const t of texts) {
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      // Plain numbers: a DOMRect's sides are getters, which a spread drops.
      const { top, bottom, left, right } = r;
      if (r.width > 0) rects.push({ top, bottom, left, right });
    }
  }
  const boxes = groupLines(rects);
  // Each character goes to the line its middle falls in.
  const chars = boxes.map(() => "");
  for (const t of texts) {
    const s = t.data;
    for (let i = 0; i < s.length; i++) {
      range.setStart(t, i);
      range.setEnd(t, i + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      const mid = (r.top + r.bottom) / 2;
      const k = boxes.findIndex((b) => mid >= b.top && mid <= b.bottom);
      if (k >= 0) chars[k] = (chars[k] ?? "") + s.charAt(i);
    }
  }
  const cs = getComputedStyle(block);
  canvas ??= document.createElement("canvas").getContext("2d");
  let ascent = 0.8;
  if (canvas) {
    canvas.font =
      `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = canvas.measureText("x");
    const sum = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    if (sum > 0) ascent = m.fontBoundingBoxAscent / sum;
  }
  const page = block.closest(".pagedjs_page");
  const leading = (parseFloat(cs.lineHeight) || 0) *
    (page ? zoomOf(page) : 1);
  return boxes.map((b, i) => {
    const mid = (b.top + b.bottom) / 2;
    const half = Math.max(leading, b.bottom - b.top) / 2;
    return {
      left: b.left,
      right: b.right,
      top: mid - half,
      bottom: mid + half,
      baseline: b.top + (b.bottom - b.top) * ascent,
      hyphenated: i + 1 < boxes.length &&
        endsMidWord(chars[i] ?? "", chars[i + 1] ?? ""),
    };
  });
}

// ---- facts ----

const pagesOf = (page: Element) =>
  [...page.parentElement?.children ?? []].filter((p) =>
    p.classList.contains("pagedjs_page")
  );

// The page's first block: what "first on the page" means. Not its first
// text, which on an opener is the chapter's number, no block of its own.
const firstBlock = (page: Element) =>
  [...page.querySelectorAll(".pagedjs_page_content [data-line]")].find((el) =>
    !el.querySelector("[data-line]")
  ) ?? null;

// Paged.js turns a page break into data-break-before on the element; an
// unconverted one is still in the computed style.
function breakBefore(el: Element, page: Element): string {
  for (let a: Element | null = el; a && a !== page; a = a.parentElement) {
    const v = a.getAttribute("data-break-before") ||
      getComputedStyle(a).breakBefore;
    if (v && v !== "auto") return v;
  }
  return "auto";
}

// The text block the target belongs to: the block a line or span is in.
const blockOf = (t: Target) =>
  t.kind === "span" ? t.el?.closest("[data-line]") ?? null : t.el;

function factsFor(t: Target, deps: Deps, lines: Line[]): InspectFacts {
  const pages = pagesOf(t.page);
  const i = pages.indexOf(t.page);
  const map = deps.pageMap();
  const page = map[i] ?? null;
  const el = t.kind === "furniture" || t.kind === "ghost" || t.kind === "space"
    ? null
    : blockOf(t);
  const first = firstBlock(t.page);
  const ref = el?.getAttribute("data-ref");
  const next = pages[i + 1];
  const continues = !!(ref && el?.hasAttribute("data-split-to") &&
    next?.querySelector(`[data-ref="${ref}"][data-split-from]`));
  let nextOpens: string | null = null;
  if (t.kind === "space") {
    const after = pages.slice(i + 1).find((_, k) => !map[i + 1 + k]?.blank);
    const opens = after?.querySelector(
      ".chapter:not([data-split-from]), .part:not([data-split-from])",
    );
    if (opens) {
      nextOpens = (opens.querySelector(".title") ?? opens.querySelector(
        ".number",
      ))?.textContent?.trim() || "the next chapter";
    }
  }
  const cs = el ? getComputedStyle(el) : null;
  // A line answers for itself: the first line for how the block starts,
  // the last for where it goes on.
  const n = t.kind === "line" ? t.line ?? 1 : null;
  const opens = n === null || n === 1;
  const ends = n === null || n === lines.length;
  const href = t.el?.matches("a.ref") ? t.el.getAttribute("href") : null;
  const id = href?.slice(1);
  return {
    kind: t.kind,
    label: nameOf(t, deps.catalog()),
    page,
    firstOnPage: opens && !!(el && first && el.contains(first)),
    breakBefore: el ? breakBefore(el, t.page) : "auto",
    splitFrom: opens && !!el?.hasAttribute("data-split-from"),
    continuesOn: continues && ends
      ? map[i + 1]?.refText ?? String(i + 2)
      : null,
    textAlignLast: cs?.textAlignLast ?? "",
    hyphens: cs?.hyphens ?? "",
    line: t.kind === "line" && t.line
      ? {
        n: t.line,
        of: lines.length,
        hyphenated: !!lines[t.line - 1]?.hyphenated,
      }
      : null,
    ref: id ? { id, refText: pageSeed()[id] ?? "?" } : null,
    furniture: t.kind === "furniture" || t.kind === "ghost"
      ? t.entry?.section === "running" ? "head" : "folio"
      : null,
    nextOpens,
  };
}

// ---- the drawer ----

interface Deps {
  metadata(): Metadata;
  catalog(): StyleEntry[];
  pageMap(): PageEntry[];
  pin(t: Target): void;
  /** The block's lines as on screen now (inspect.ts measures them once). */
  lines(block: Element, page: Element): Line[];
  style(key: string): void;
  source(line: number): void;
}

const ZONES = { front: "Front matter", body: "Body", back: "Back matter" };
const ALIGN: Record<string, string> = {
  start: "Left",
  left: "Left",
  end: "Right",
  right: "Right",
  center: "Centred",
  justify: "Justified",
};
const HYPHENS: Record<string, string> = {
  auto: "Automatic",
  manual: "Manual",
  none: "None",
};

const label = (text: string) => h("h3", {}, text);

export function renderDrawer(
  host: HTMLElement,
  t: Target | null,
  deps: Deps,
): void {
  host.hidden = !t;
  if (!t) return host.replaceChildren();
  const catalog = deps.catalog();
  const unit = unitFor(deps.metadata());
  const pages = pagesOf(t.page);
  const pageIdx = pages.indexOf(t.page);
  const entry = deps.pageMap()[pageIdx];
  const block = blockOf(t);
  const text = t.kind === "block" || t.kind === "line" || t.kind === "span";
  const lines = text && block ? deps.lines(block, t.page) : [];
  const z = zoomOf(t.page);
  const len = (px: number) => fmtLength(px / 96, unit);
  const blockEntry = (el: Element) => {
    const container = el.closest<HTMLElement>("#preview");
    const key = container && resolveStyle(el, container, catalog)?.key;
    return catalog.find((e) => e.key === key) ?? null;
  };
  const pinBlock = (el: Element) => ({
    kind: "block" as const,
    el,
    page: el.closest(".pagedjs_page") ?? t.page,
    line: null,
    entry: blockEntry(el),
  });

  // Where it sits: zone › chapter › block › line › span, or for what has no
  // text of its own, page › margin or text block › it.
  let n = t.line;
  if (t.kind === "span") {
    const r = t.el!.getClientRects()[0];
    const mid = r ? (r.top + r.bottom) / 2 : NaN;
    n = lines.findIndex((l) => mid >= l.top && mid <= l.bottom) + 1 || null;
  }
  const crumbs: Array<{ text: string; go?: () => void }> = [];
  if (text && block) {
    if (entry) crumbs.push({ text: ZONES[entry.zone] });
    const chapter = block.closest(".chapter, .part");
    const ref = chapter?.getAttribute("data-ref");
    const start = ref
      ? t.page.parentElement?.querySelector(
        `[data-ref="${ref}"]:not([data-split-from])`,
      )
      : null;
    const title = start?.querySelector(":scope > .title") ??
      start?.querySelector(":scope > .number");
    if (title) {
      crumbs.push({
        text: title.textContent?.trim() ?? "",
        go: title === block ? undefined : () => deps.pin(pinBlock(title)),
      });
    }
    const whole = t.kind === "span"
      ? pinBlock(block)
      : { ...t, kind: "block" as const, line: null };
    crumbs.push({
      text: nameOf(whole, catalog),
      go: t.kind === "block" ? undefined : () => deps.pin(whole),
    });
    if (n) {
      crumbs.push({
        text: `Line ${n}`,
        go: t.kind === "line"
          ? undefined
          : () => deps.pin({ ...whole, kind: "line", line: n }),
      });
    }
    if (t.kind === "span") crumbs.push({ text: nameOf(t, catalog) });
  } else {
    crumbs.push({ text: `Page ${entry?.refText || pageIdx + 1}` });
    const area = [...t.el?.classList ?? []].find((c) =>
      c.startsWith("pagedjs_margin-")
    );
    crumbs.push({
      text: !area
        ? "Text block"
        : area.includes("-top")
        ? "Top margin"
        : area.includes("-bottom")
        ? "Bottom margin"
        : "Side margin",
    });
    crumbs.push({ text: nameOf(t, catalog) });
  }
  const nav = h("nav", { class: "crumbs", "aria-label": "Where this sits" });
  crumbs.forEach((c, i) => {
    if (i) nav.append(h("span", { class: "sep", "aria-hidden": "true" }, "›"));
    const last = i === crumbs.length - 1;
    const b = h("button", {
      type: "button",
      class: last ? "on" : c.go ? "" : "off",
      "aria-current": last ? "location" : undefined,
    }, c.text);
    if (c.go && !last) b.onclick = c.go;
    else b.disabled = true;
    nav.append(b);
  });

  const actions = h("div", { class: "actions" });
  const line = Number(
    (block ?? t.el)?.closest("[data-line]")?.getAttribute("data-line"),
  );
  if (line) {
    const b = h(
      "button",
      { type: "button", class: "btn sm outline" },
      "Show in manuscript",
    );
    b.onclick = () => deps.source(line);
    actions.append(b);
  }
  if (t.entry) {
    const key = t.entry.key;
    const b = h(
      "button",
      { type: "button", class: "btn sm outline" },
      "Open in Style",
    );
    b.onclick = () => deps.style(key);
    actions.append(b);
  }

  // Why it's here.
  const why = h("section", { class: "why" }, label("Why it's here"));
  const reasons = reasonsFor(factsFor(t, deps, lines));
  if (!reasons.length) {
    reasons.push(
      t.kind === "span"
        ? { text: "Marked in the manuscript", source: "Manuscript" }
        : { text: "Follows on from what comes before it", source: "Layout" },
    );
  }
  for (const r of reasons) {
    why.append(h("p", {}, r.text, h("span", { class: "src" }, r.source)));
  }
  if (lines.length && (t.kind === "block" || t.kind === "line") && block) {
    const chips = h("div", { class: "lines" }, h("span", {}, "Lines"));
    lines.forEach((_, i) => {
      const b = h("button", {
        type: "button",
        class: "chip",
        "aria-pressed": String(t.kind === "line" && t.line === i + 1),
      }, String(i + 1));
      b.onclick = () =>
        deps.pin({ ...t, el: block, kind: "line", line: i + 1 });
      chips.append(b);
    });
    why.append(chips);
  }

  // Box: the target's size, and for a block or line its space and indent.
  const box = h("section", { class: "box" }, label("Box"));
  const rect = t.kind === "line"
    ? lines[(t.line ?? 1) - 1]
    : t.kind === "space"
    ? spaceRect(t.page)
    : t.kind === "ghost"
    ? null
    : t.el?.getBoundingClientRect();
  const size = rect
    ? `${len((rect.right - rect.left) / z)} × ${
      len((rect.bottom - rect.top) / z)
    }`
    : "";
  if ((t.kind === "block" || t.kind === "line") && t.el) {
    const cs = getComputedStyle(t.el);
    const px = (v: string) => parseFloat(v) || 0;
    const isLine = t.kind === "line";
    const indent = isLine && t.line !== 1 ? 0 : px(cs.textIndent);
    box.append(
      h(
        "div",
        { class: "model" },
        h(
          "div",
          {},
          h("span", {}, "space above"),
          h("b", {}, len(isLine ? 0 : px(cs.marginTop))),
        ),
        h(
          "div",
          { class: "mid" },
          h("b", { class: "indent", title: "First-line indent" }, len(indent)),
          h("b", { class: "inner" }, size),
        ),
        h(
          "div",
          {},
          h("span", {}, "space below"),
          h("b", {}, len(isLine ? 0 : px(cs.marginBottom))),
        ),
      ),
      h(
        "div",
        { class: "key" },
        h("span", { class: "indent" }, "indent"),
        h("span", { class: "space" }, "spacing"),
      ),
    );
  } else {
    box.append(h(
      "div",
      { class: "plain" },
      t.kind === "span"
        ? n ? `Inline, on line ${n}` : "Inline"
        : t.kind === "ghost"
        ? "Not printed"
        : size,
    ));
  }

  // Type: what the browser set it in, and where each value comes from.
  const type = h("section", { class: "type" }, label("Type"));
  const typed = t.kind === "space"
    ? null
    : t.kind === "furniture" || t.kind === "ghost"
    ? t.el?.querySelector(".pagedjs_margin-content") ?? t.el
    : t.el;
  if (typed) {
    const cs = getComputedStyle(typed);
    const metadata = deps.metadata();
    const lh = parseFloat(cs.lineHeight);
    const rows: Array<[string, string, string]> = [
      ["Font", faceOf(cs.fontFamily), "font-family"],
      ["Size", `${points(parseFloat(cs.fontSize))} pt`, "font-size"],
      ["Leading", lh ? `${points(lh)} pt` : "Normal", "line-height"],
      ["Align", ALIGN[cs.textAlign] ?? cs.textAlign, "text-align"],
      ["Hyphens", HYPHENS[cs.hyphens] ?? cs.hyphens, "hyphens"],
    ];
    for (const [k, v, prop] of rows) {
      const from: ValueSource = t.entry
        ? sourceOf(metadata, t.entry, prop, catalog)
        : { kind: "default" };
      type.append(
        h(
          "div",
          { class: from.kind === "set" ? "row" : "row inherited" },
          h("span", {}, k),
          h(
            "span",
            {},
            h("span", { class: "v" }, v),
            h(
              "span",
              { class: "src" },
              from.kind === "set"
                ? `Style › ${from.label}`
                : from.kind === "inherited"
                ? `from ${from.label}`
                : "Book default",
            ),
          ),
        ),
      );
    }
  } else type.append(h("p", { class: "none" }, "Nothing is styled here."));

  host.replaceChildren(
    h("header", {}, nav, actions),
    h("div", { class: "body" }, why, box, type),
  );
}
