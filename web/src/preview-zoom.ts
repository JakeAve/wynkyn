// web/src/preview-zoom.ts — zoom on the pages (spec §7.6, design-language.md
// §6.11): − 100% + in the pages header, its menu (Fit spread, Fit page), and
// ⌘-wheel or a trackpad pinch over the pages. The factor is the reader's own
// (localStorage preview-zoom); 1 is fitPreview's fit, a spread across the pane.
// It is --preview-user on #preview, which app.css multiplies by --preview-fit:
// only CSS zoom, so a zoom never re-renders and nothing lands on the pages.
import { store } from "./dom.ts";
import { LIVE_PAGE } from "./preview.ts";

// 50% to 400% in tens.
export const ZOOM_STEPS = Array.from({ length: 36 }, (_, i) => (i + 5) / 10);
const MIN = 0.5;
const MAX = 4;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

// The next step from `z` in that direction; from between steps, the nearest
// one that way. At either end it stays at the end.
export function stepZoom(z: number, dir: 1 | -1): number {
  const next = dir > 0
    ? ZOOM_STEPS.find((s) => s > z + 1e-3)
    : ZOOM_STEPS.findLast((s) => s < z - 1e-3);
  return next ?? (dir > 0 ? MAX : MIN);
}

// The factor at which one whole page (unzoomed pageW × pageH) fits the pane's
// room, given the spread fit already applied.
export function fitPageZoom(
  paneW: number,
  paneH: number,
  pageW: number,
  pageH: number,
  fitSpread: number,
): number {
  return Math.min(paneW / pageW, paneH / pageH) / fitSpread;
}

export function installPreviewZoom(
  deps: { container: HTMLElement; out: HTMLElement },
): { zoom(): number } {
  const { container, out } = deps;
  const btn = (z: string) =>
    out.querySelector<HTMLButtonElement>(`[data-zoom="${z}"]`)!;
  const [minus, plus, pct] = [btn("out"), btn("in"), btn("menu")];
  const menu = out.querySelector<HTMLElement>("[popover]")!;
  let user = 1;
  let saving = 0;
  const save = () => {
    clearTimeout(saving);
    store("preview-zoom", String(user));
  };

  const fitPage = () => {
    const page = container.querySelector<HTMLElement>(LIVE_PAGE);
    if (!page) return 1;
    const pad = 2 * parseFloat(getComputedStyle(container).paddingLeft);
    const s = getComputedStyle(page); // unzoomed lengths
    return fitPageZoom(
      container.clientWidth - pad,
      container.clientHeight - pad,
      parseFloat(s.width),
      parseFloat(s.height),
      parseFloat(container.style.getPropertyValue("--preview-fit")) || 1,
    );
  };

  // Keep the point at (x, y) — the pointer, or the pane's centre — over the
  // same spot on the pages: the pages box scales evenly, so its fraction
  // under the point is the anchor.
  // `wait`: a pinch saves once it rests, not on every wheel event.
  const set = (z: number, x?: number, y?: number, wait = 0) => {
    user = clamp(z);
    const box = container.querySelector(
      ":scope > :not(.preview-stage) .pagedjs_pages",
    );
    const c = container.getBoundingClientRect();
    x ??= c.left + c.width / 2;
    y ??= c.top + c.height / 2;
    const r = box?.getBoundingClientRect();
    container.style.setProperty("--preview-user", String(+user.toFixed(4)));
    pct.textContent = `${Math.round(user * 100)}%`;
    minus.disabled = user <= MIN;
    plus.disabled = user >= MAX;
    if (wait) {
      clearTimeout(saving);
      saving = setTimeout(save, wait);
    } else save();
    if (!box || !r?.width || !r.height) return;
    const n = box.getBoundingClientRect();
    container.scrollLeft += n.left + (x - r.left) / r.width * n.width - x;
    container.scrollTop += n.top + (y - r.top) / r.height * n.height - y;
  };

  minus.onclick = () => set(stepZoom(user, -1));
  plus.onclick = () => set(stepZoom(user, 1));
  menu.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = pct.getBoundingClientRect();
    menu.style.top = `${r.bottom}px`;
    menu.style.right = `${innerWidth - r.right}px`;
    const page = fitPage();
    for (const item of menu.querySelectorAll<HTMLElement>("[data-fit]")) {
      const z = item.dataset.fit === "page" ? page : 1;
      item.setAttribute("aria-checked", String(Math.abs(z - user) < 1e-3));
    }
  });
  menu.onclick = (e) => {
    const item = (e.target as Element).closest<HTMLElement>("[data-fit]");
    if (!item) return;
    menu.hidePopover();
    if (item.dataset.fit !== "page") return set(1);
    // Fit page centres the page that was at the pane's centre.
    const c = container.getBoundingClientRect();
    const mid = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2];
    const [cx, cy] = mid(c) as [number, number];
    let page: Element | undefined, best = Infinity;
    for (const p of container.querySelectorAll(LIVE_PAGE)) {
      const [px, py] = mid(p.getBoundingClientRect()) as [number, number];
      const d = Math.hypot(px - cx, py - cy);
      if (d < best) [page, best] = [p, d];
    }
    set(fitPage());
    if (!page) return;
    const [px, py] = mid(page.getBoundingClientRect()) as [number, number];
    container.scrollLeft += px - cx;
    container.scrollTop += py - cy;
  };
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // a pinch arrives as ctrl+wheel
    e.preventDefault();
    const d = e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY * 16
      : e.deltaY;
    // A mouse notch (~100) is clamped to about a fifth; a pinch's small deltas
    // pass through, so it tracks the fingers.
    set(
      user * Math.exp(-Math.max(-50, Math.min(50, d)) / 200),
      e.clientX,
      e.clientY,
      250,
    );
  }, { passive: false });

  set(Number(store("preview-zoom")) || 1);
  return { zoom: () => user };
}
