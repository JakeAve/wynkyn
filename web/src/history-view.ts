// History's versions (the toolbar menu's rows) and what one changed (the
// middle column, on request);
// design-language §6.14.
import type { Metadata } from "../../metadata/types.ts";
import {
  type ChapterDiff,
  diffMetadata,
  diffText,
} from "../../server/history-diff.ts";
import type { RestoreScope, Version } from "../../server/history.ts";
import type { Backend } from "./backend.ts";
import { h, row, section, seg } from "./panel-controls.ts";
import { catalogFor, entryName } from "./style-catalog.ts";

export interface HistoryBackend {
  history(book: string): Promise<Version[]>;
  versionFiles(
    book: string,
    id: string,
  ): Promise<{ version: Version; files: Record<string, string> }>;
  restoreVersion(
    book: string,
    id: string,
    scope: RestoreScope,
  ): Promise<Version | null>;
  nameVersion(book: string, id: string | null, name: string): Promise<Version>;
}

export type Filter = "edition" | "all";
export type DayItem = Version | { fold: Version[] };
export interface Day {
  label: string;
  items: DayItem[];
}

const DAY_MS = 86_400_000;
// Not Intl: its punctuation differs between engines and versions.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function dayLabel(at: Date, now: Date): string {
  // Rounded: a day across a DST change is 23 or 25 hours.
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const year = at.getFullYear() === now.getFullYear()
    ? ""
    : ` ${at.getFullYear()}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${
    MONTHS[at.getMonth()]
  }${year}`;
}

export function timeLabel(at: Date): string {
  const hr = at.getHours();
  const m = String(at.getMinutes()).padStart(2, "0");
  return `${hr % 12 || 12}:${m} ${hr < 12 ? "am" : "pm"}`;
}

export const whenLabel = (v: Version, now: Date) =>
  `${dayLabel(new Date(v.at), now)}, ${timeLabel(new Date(v.at))}`;

const changed = (v: Version) =>
  v.changes.text || v.changes.images || v.changes.editions.length > 0;

const otherEditionOnly = (v: Version, edition: string | null) =>
  !v.changes.text && !v.changes.images && v.changes.editions.length > 0 &&
  v.changes.editions.every((e) => e !== edition);

export function visible(
  v: Version,
  edition: string | null,
  filter: Filter,
): boolean {
  if (v.reason === "open" && !changed(v)) return false;
  return filter === "all" || !otherEditionOnly(v, edition);
}

export function reasonLabel(v: Version): string {
  switch (v.reason) {
    case "open":
      return changed(v) ? "Opened, changed outside the app" : "";
    case "before-import":
      return "Before import";
    case "before-delete-edition":
      return "Before deleting edition";
    case "before-reload":
      return "Before reload";
    case "before-restore":
      return "Before restore";
    default:
      return "";
  }
}

const foldable = (v: Version) =>
  v.name === undefined && (v.reason === "idle" || v.reason === "max");

/** Newest-first versions → days; on days before today, runs of plain
 * idle/max versions keep their first two and fold the rest. */
export function groupVersions(
  versions: Version[],
  now: Date,
  edition: string | null,
  filter: Filter,
): Day[] {
  const days: Day[] = [];
  for (const v of versions) {
    if (!visible(v, edition, filter)) continue;
    const label = dayLabel(new Date(v.at), now);
    let day = days.at(-1);
    if (day?.label !== label) days.push(day = { label, items: [] });
    day.items.push(v);
  }
  for (const day of days) {
    if (day.label === "Today") continue;
    const out: DayItem[] = [];
    let run = 0;
    for (const item of day.items as Version[]) {
      run = foldable(item) ? run + 1 : 0;
      const last = out.at(-1);
      if (run <= 2) out.push(item);
      else if (last && "fold" in last) last.fold.push(item);
      else out.push({ fold: [item] });
    }
    day.items = out;
  }
  return days;
}

const words = (s: string) => s.replace(/-/g, " ");

export function chaptersLabel(chapters: string[]): string {
  const ch = chapters.filter((c) => c !== "Front matter").map(words);
  const front = chapters.includes("Front matter") ? ["Front matter"] : [];
  const named = ch.length === 0
    ? []
    : [`${ch.length === 1 ? "Chapter" : "Chapters"} ${ch.join(", ")}`];
  return [...front, ...named].join(", ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const editionLabel = (
  slug: string | null,
  names: Map<string | null, string> = new Map(),
) =>
  `${
    names.get(slug) ?? (slug === null ? "Standard" : cap(words(slug)))
  } edition`;

/** `styleParts`: the changed parts' labels per edition, once fetched. */
export function rowLabel(
  v: Version,
  edition: string | null,
  opts: {
    names?: Map<string | null, string>;
    styleParts?: Map<string | null, string[]>;
  } = {},
): { head: string; detail: string } {
  const bits: { head: string; detail: string }[] = [];
  if (v.changes.text) {
    bits.push({ head: "Text", detail: chaptersLabel(v.changes.chapters) });
  }
  for (const e of v.changes.editions) {
    bits.push({
      head: e === edition ? "Styles" : editionLabel(e, opts.names),
      detail: (opts.styleParts?.get(e) ?? []).join(", "),
    });
  }
  if (v.changes.images) bits.push({ head: "Images", detail: "" });
  const heads = bits.map((b) => b.head).join(" · ");
  if (v.name !== undefined) {
    return { head: v.name, detail: heads };
  }
  if (bits.length === 1) return bits[0]!;
  return {
    head: heads || "No changes",
    detail: bits.map((b) => b.detail).filter(Boolean).join(" · "),
  };
}

// The panel builds its rows inline, so it has no label map to share.
const PROP_LABELS: Record<string, string> = {
  "font-family": "Font",
  "font-size": "Size",
  "font-style": "Italic",
  "font-weight": "Weight",
  "text-transform": "Case",
  "font-variant-caps": "Small caps",
  "text-align": "Alignment",
  "letter-spacing": "Letter spacing",
  "margin-top": "Space above",
  "margin-bottom": "Space below",
  "line-height": "Line spacing",
  "text-indent": "First-line indent",
  hyphens: "Hyphenation",
  content: "Ornament",
};

const SECTION_LABELS: Record<string, string> = {
  page: "Page setup",
  fonts: "Fonts",
  toc: "Contents",
  notes: "Notes",
  ebook: "E-book",
  language: "Language",
  name: "Edition name",
  spec: "Spec version",
};

const show = (x: unknown) =>
  x === undefined ? "unset" : typeof x === "string" ? x : JSON.stringify(x);

export interface StyleRow {
  prop: string;
  from: string;
  to: string;
}

export function styleGroups(
  before: Metadata | null,
  after: Metadata | null,
): Map<string, StyleRow[]> {
  const catalog = catalogFor(after ?? before ?? {});
  const deepestFirst = [...catalog].sort((a, b) =>
    b.path.length - a.path.length
  );
  const out = new Map<string, StyleRow[]>();
  for (const c of diffMetadata(before, after)) {
    const e = deepestFirst.find((e) => e.path.every((p, i) => c.path[i] === p));
    const [part, rest] = e
      ? [
        entryName(e, catalog),
        c.path.slice(e.path.length).filter((p) => p !== "css"),
      ]
      : [
        SECTION_LABELS[c.path[0] ?? ""] ?? cap(words(c.path[0] ?? "")),
        c.path.slice(1),
      ];
    const last = rest.at(-1);
    const prop = last === undefined
      ? part
      : PROP_LABELS[last] ?? cap(words(rest.join(" ")));
    const rows = out.get(part) ?? [];
    rows.push({ prop, from: show(c.from), to: show(c.to) });
    out.set(part, rows);
  }
  return out;
}

// ---- DOM ----

const metaPath = (e: string | null) =>
  e === null ? "metadata.json" : `editions/${e}.json`;

function parseMeta(text: string | undefined): Metadata | null {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as Metadata;
  } catch {
    return null;
  }
}

interface VersionDiff {
  text: ChapterDiff[];
  styles: { edition: string | null; groups: Map<string, StyleRow[]> }[];
}

interface Restore {
  label: string;
  note: string;
  what: string;
  scope: (edition: string | null) => RestoreScope;
}

const RESTORES: Restore[] = [
  {
    label: "Everything",
    note: "Text and every edition’s styles",
    what: "everything",
    scope: () => "all",
  },
  {
    label: "Text only",
    note: "Keep the current styles",
    what: "the text",
    scope: () => "text",
  },
  {
    label: "Styles only",
    note: "Keep the current text",
    what: "the styles",
    scope: () => "styles",
  },
  {
    label: "This edition’s styles",
    note: "Other editions stay as they are",
    what: "this edition’s styles",
    scope: (edition) => ({ edition }),
  },
];

function summaryOf(
  v: Version,
  edition: string | null,
  names: Map<string | null, string>,
): string {
  if (v.name !== undefined) return "Named versions are kept forever.";
  switch (v.reason) {
    case "open":
      return "Something changed the book’s files while the app was closed: an agent, the CLI or another editor.";
    case "before-import":
      return "Taken just before Import replaced the manuscript. Restore “Text only” to get the old manuscript back and keep today’s styles.";
    case "before-delete-edition":
      return "Taken just before an edition was deleted. Restore “Everything” to bring it back.";
    case "before-reload":
      return "Taken just before the app reloaded over unsaved text.";
    case "before-restore":
      return "The book just before a restore. Restore this to undo it.";
  }
  const only = v.changes.editions[0];
  if (
    only !== undefined && v.changes.editions.length === 1 &&
    otherEditionOnly(v, edition)
  ) {
    return `Only the ${
      editionLabel(only, names)
    } changed. The manuscript is shared, so its text is untouched.`;
  }
  return "";
}

function headingOf(
  v: Version,
  edition: string | null,
  names: Map<string | null, string>,
): string {
  if (v.name !== undefined) return v.name;
  if (v.reason === "open") return "Changed outside the app";
  const reason = reasonLabel(v);
  if (reason) return reason;
  const styles = v.changes.editions.length > 0;
  const only = v.changes.editions[0];
  if (v.changes.text && styles) return "Text and styles changed";
  if (v.changes.text) return "Text changed";
  if (
    only !== undefined && v.changes.editions.length === 1 &&
    otherEditionOnly(v, edition)
  ) {
    return `${editionLabel(only, names)}: styles changed`;
  }
  if (styles) return "Styles changed";
  if (v.changes.images) return "Images changed";
  return "No changes";
}

const SVG = "http://www.w3.org/2000/svg";
function star(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "h-star");
  svg.setAttribute("aria-label", "Named");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute(
    "d",
    "M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z",
  );
  svg.append(path);
  return svg;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function createHistoryView(opts: {
  list: HTMLElement;
  changes: HTMLElement;
  backend: HistoryBackend & Pick<Backend, "editions">;
  book: string;
  edition: string | null;
  onSelect(v: Version | "now"): void;
  /** `scope` is the one restored, so an Undo can restore `before` the same way. */
  onRestored(before: Version | null, label: string, scope: RestoreScope): void;
  onName(target: Version | "now"): void;
}): {
  refresh(): Promise<void>;
  select(id: string | "now"): void;
  /** Restore ▾ and its menu for the selected version, small for a banner. */
  restoreControl(): Node[];
  destroy(): void;
} {
  const { list, changes, backend, book, edition } = opts;
  list.classList.add("history-list");
  changes.classList.add("history-changes");
  let versions: Version[] = [];
  let names = new Map<string | null, string>();
  let filter: Filter = "edition";
  let selected: string = "now";
  let alive = true;
  const open = new Set<string>(); // expanded folds, by their first id
  const files = new Map<string, Promise<Record<string, string>>>();
  const diffs = new Map<string, Promise<VersionDiff>>();
  const parts = new Map<string, Map<string | null, string[]>>();

  const filesOf = (id: string) => {
    let p = files.get(id);
    if (!p) {
      p = backend.versionFiles(book, id).then((r) => r.files);
      p.catch(() => files.delete(id));
      files.set(id, p);
    }
    return p;
  };

  // Against the version before it in every edition, whatever the filter shows.
  const diffOf = (v: Version): Promise<VersionDiff> => {
    let p = diffs.get(v.id);
    if (p) return p;
    p = (async () => {
      const prev = versions[versions.indexOf(v) + 1];
      const [after, before] = await Promise.all([
        filesOf(v.id),
        prev ? filesOf(prev.id) : Promise.resolve<Record<string, string>>({}),
      ]);
      return {
        text: v.changes.text
          ? diffText(
            before["manuscript.md"] ?? "",
            after["manuscript.md"] ?? "",
          )
          : [],
        styles: v.changes.editions.map((e) => ({
          edition: e,
          groups: styleGroups(
            parseMeta(before[metaPath(e)]),
            parseMeta(after[metaPath(e)]),
          ),
        })),
      };
    })();
    p.catch(() => diffs.delete(v.id));
    diffs.set(v.id, p);
    return p;
  };

  const alert = (lead: string, err: unknown) => {
    changes.querySelector(":scope > .banner")?.remove();
    changes.prepend(
      h(
        "div",
        { class: "banner err", role: "alert" },
        h("strong", {}, lead),
        message(err),
      ),
    );
  };

  const rowButton = (
    id: string,
    time: string,
    label: { head: string; detail: string },
    reason: string,
    named = false,
  ) => {
    const b = h(
      "button",
      {
        type: "button",
        class: "h-row",
        "data-id": id,
        "aria-current": id === selected ? "true" : undefined,
      },
      h("span", { class: "h-time" }, time),
      h("span", { class: "h-head" }, ...named ? [star()] : [], label.head),
      h("span", { class: "h-detail" }, label.detail),
    );
    if (reason) b.append(h("i", { class: "h-reason" }, reason));
    b.onclick = () => {
      select(id);
      opts.onSelect(versions.find((x) => x.id === id) ?? "now");
    };
    return b;
  };

  const versionRow = (v: Version) => {
    const label = () =>
      rowLabel(v, edition, { names, styleParts: parts.get(v.id) });
    const b = rowButton(
      v.id,
      timeLabel(new Date(v.at)),
      label(),
      reasonLabel(v),
      v.name !== undefined,
    );
    // ponytail: two versionFiles calls per style row to name its parts, cached;
    // a per-version summary from the service if long histories feel slow.
    if (v.changes.editions.length && !parts.has(v.id)) {
      diffOf(v).then((d) => {
        parts.set(
          v.id,
          new Map(d.styles.map((s) => [s.edition, [...s.groups.keys()]])),
        );
        const detail = b.querySelector(".h-detail");
        if (alive && detail) detail.textContent = label().detail;
      }, () => {});
    }
    return b;
  };

  const drawList = () => {
    const days = groupVersions(versions, new Date(), edition, filter);
    if (days[0]?.label !== "Today") days.unshift({ label: "Today", items: [] });
    const body: Node[] = [];
    if (names.size > 1) {
      body.push(seg(
        [
          { value: "edition", label: "This edition" },
          { value: "all", label: "All editions" },
        ],
        filter,
        (f) => {
          if (!f) return;
          filter = f;
          const v = versions.find((x) => x.id === selected);
          if (v && !visible(v, edition, filter)) select("now");
          else drawList();
        },
        "Show versions from",
      ));
    }
    days.forEach((day, i) => {
      body.push(h("div", { class: "nh" }, day.label));
      if (i === 0) {
        body.push(rowButton("now", "Now", {
          head: "Current version",
          detail: "Everything saved so far",
        }, ""));
      }
      for (const item of day.items) {
        if (!("fold" in item)) {
          body.push(versionRow(item));
          continue;
        }
        const key = item.fold[0]?.id ?? "";
        if (open.has(key) || item.fold.some((v) => v.id === selected)) {
          body.push(...item.fold.map(versionRow));
          continue;
        }
        const more = h("button", {
          type: "button",
          class: "btn sm",
          "aria-expanded": "false",
        }, `▸ ${item.fold.length} more`);
        more.onclick = () => {
          open.add(key);
          drawList();
        };
        body.push(more);
      }
    });
    list.replaceChildren(...body);
  };

  async function restore(v: Version, r: Restore) {
    const scope = r.scope(edition);
    const label = `${r.what} from ${whenLabel(v, new Date())}`;
    let before: Version | null;
    try {
      before = await backend.restoreVersion(book, v.id, scope);
    } catch (err) {
      if (alive) alert("Couldn’t restore. ", err);
      return;
    }
    if (!alive) return;
    opts.onRestored(before, label, scope);
    selected = "now";
    await refresh();
  }

  // A native popover, like the zoom menu: light dismiss, Esc and the
  // trigger's expanded state come with it.
  const restoreMenu = (v: Version, small = false) => {
    const menu = h("div", { class: "menu", role: "menu", popover: "" });
    const btn = h("button", {
      type: "button",
      class: small ? "btn sm primary" : "btn primary",
      "aria-haspopup": "menu",
    }, "Restore ▾");
    btn.popoverTargetElement = menu;
    menu.addEventListener("beforetoggle", (e) => {
      if ((e as ToggleEvent).newState !== "open") return;
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom}px`;
      menu.style.left = `${r.left}px`;
    });
    menu.addEventListener("toggle", (e) => {
      if ((e as ToggleEvent).newState !== "open") return;
      // Under a button at the window's right edge it opens leftward.
      const r = btn.getBoundingClientRect();
      if (r.left + menu.offsetWidth > innerWidth) {
        menu.style.left = `${r.right - menu.offsetWidth}px`;
      }
      (menu.firstElementChild as HTMLElement | null)?.focus();
    });
    menu.append(...RESTORES.map((r) => {
      const item = h(
        "button",
        { type: "button", role: "menuitem" },
        r.label,
        h("span", { class: "d" }, r.note),
      );
      item.onclick = () => {
        menu.hidePopover();
        void restore(v, r);
      };
      return item;
    }));
    return [btn, menu];
  };

  const heading = (crumb: Node[], title: string, actions: Node[]) =>
    h(
      "div",
      { class: "phead" },
      h("div", { class: "crumb" }, ...crumb),
      h("h2", {}, title),
      h("div", { class: "h-actions" }, ...actions),
    );

  let drawToken = 0;
  const drawChanges = () => {
    const token = ++drawToken;
    const v = versions.find((x) => x.id === selected);
    const nameBtn = h("button", { type: "button", class: "btn" }, "Name…");
    nameBtn.onclick = () => opts.onName(v ?? "now");
    if (!v) {
      changes.replaceChildren(
        heading([document.createTextNode("Now")], "Current version", [
          nameBtn,
        ]),
        h(
          "div",
          { class: "pbody" },
          h(
            "p",
            { class: "h-summary" },
            "This is the book right now. Name it to keep a checkpoint, like “Sent to printer”.",
          ),
        ),
      );
      return;
    }
    const reason = reasonLabel(v);
    const crumb: Node[] = [document.createTextNode(whenLabel(v, new Date()))];
    if (reason) crumb.push(document.createTextNode(" · "), h("i", {}, reason));
    const summary = summaryOf(v, edition, names);
    const body = h("div", { class: "pbody" });
    if (summary) body.append(h("p", { class: "h-summary" }, summary));
    changes.replaceChildren(
      heading(crumb, headingOf(v, edition, names), [
        ...restoreMenu(v),
        nameBtn,
      ]),
      body,
    );
    if (!v.changes.text && !v.changes.editions.length) return;
    const loading = h("p", { class: "h-note" }, "Loading changes…");
    body.append(loading);
    diffOf(v).then((d) => {
      if (token !== drawToken || !alive) return;
      const out: Node[] = [];
      for (const s of d.styles) {
        const prefix = s.edition === edition
          ? ""
          : `${editionLabel(s.edition, names)} · `;
        for (const [part, rows] of s.groups) {
          out.push(section(
            prefix + part,
            "",
            rows.map((r) =>
              row(
                r.prop,
                h(
                  "span",
                  { class: "h-to" },
                  h("span", { class: "h-from" }, r.from),
                  " → ",
                  r.to,
                ),
              )
            ),
          ));
        }
      }
      for (const c of d.text) {
        out.push(section(
          chaptersLabel([c.chapter]),
          "",
          c.paras.map((p) =>
            h(
              "p",
              { class: "h-para" },
              ...p.segs.map((s) =>
                s.op === "same"
                  ? s.t
                  : h(s.op === "ins" ? "ins" : "del", {}, s.t)
              ),
            )
          ),
        ));
      }
      if (d.text.length) {
        out.push(h(
          "p",
          { class: "h-note" },
          "Select any text to copy it. Nothing changes until you restore.",
        ));
      }
      loading.replaceWith(...out);
    }, (err) => {
      if (token !== drawToken || !alive) return;
      loading.remove();
      alert("Couldn’t load the changes. ", err);
    });
  };

  function select(id: string | "now") {
    selected = versions.some((v) => v.id === id) ? id : "now";
    drawList();
    drawChanges();
  }

  async function refresh() {
    const [vs, eds] = await Promise.all([
      backend.history(book),
      backend.editions(book),
    ]);
    if (!alive) return;
    versions = vs;
    names = new Map(eds.map((e) => [e.slug, e.name]));
    select(selected);
  }

  return {
    refresh,
    select,
    restoreControl() {
      const v = versions.find((x) => x.id === selected);
      return v ? restoreMenu(v, true) : [];
    },
    destroy() {
      alive = false;
      list.replaceChildren();
      changes.replaceChildren();
      list.classList.remove("history-list");
      changes.classList.remove("history-changes");
    },
  };
}
