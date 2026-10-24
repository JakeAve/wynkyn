// web/src/history-view.ts — the History takeover's left and middle columns:
// versions grouped by day (left) and what the picked one changed (middle),
// with Restore ▾ and Name…. The pure parts (grouping, folds, row and reason
// wording, style rows) are exported and tested in Deno; the rest is DOM.
import type { Metadata } from "../../metadata/types.ts";
import {
  type ChapterDiff,
  diffMetadata,
  diffText,
} from "../../server/history-diff.ts";
import type { RestoreScope, Version } from "../../server/history.ts";
import type { Backend } from "./backend.ts";
import { h } from "./panel-controls.ts";
import { catalogFor, type StyleEntry } from "./style-catalog.ts";

export type Filter = "edition" | "all";
export type DayItem = Version | { fold: Version[] };
export interface Day {
  label: string;
  items: DayItem[];
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Yesterday", else "Tue 21 Oct" (with the year if not this one). */
export function dayLabel(at: Date, now: Date): string {
  // ponytail: whole-day count by rounding, so a DST shift doesn't skip a day.
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

/** "3:42 pm". */
export function timeLabel(at: Date): string {
  const hr = at.getHours();
  const m = String(at.getMinutes()).padStart(2, "0");
  return `${hr % 12 || 12}:${m} ${hr < 12 ? "am" : "pm"}`;
}

/** "Today, 3:42 pm". */
export const whenLabel = (v: Version, now: Date) =>
  `${dayLabel(new Date(v.at), now)}, ${timeLabel(new Date(v.at))}`;

const changed = (v: Version) =>
  v.changes.text || v.changes.images || v.changes.editions.length > 0;

/** Only another edition's styles changed. */
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

/** The italic line under a row; "" when there is none. */
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

/** "Chapter three", "Chapters three, four", "Front matter". */
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

/** The row's bold head and the line under it. `styleParts` are the changed
 * parts' labels per edition, once known. */
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
    return { head: `★ ${v.name}`, detail: heads };
  }
  if (bits.length === 1) return bits[0]!;
  return {
    head: heads || "No changes",
    detail: bits.map((b) => b.detail).filter(Boolean).join(" · "),
  };
}

// ---- style rows ----

// The words the style panel's rows use (panel-parts.ts, panel-furniture.ts).
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

function partLabel(e: StyleEntry): string {
  if (e.label === "Everything" || e.label.startsWith("All ")) return e.group;
  if (e.section === "elements" && e.key.includes(".")) {
    return `${e.group} ${e.label.toLowerCase()}`;
  }
  return e.label;
}

const show = (x: unknown) =>
  x === undefined ? "unset" : typeof x === "string" ? x : JSON.stringify(x);

export interface StyleRow {
  prop: string;
  from: string;
  to: string;
}

/** Metadata changes as plain-worded rows grouped by part. */
export function styleGroups(
  before: Metadata | null,
  after: Metadata | null,
): Map<string, StyleRow[]> {
  const catalog = catalogFor(after ?? before ?? {})
    .sort((a, b) => b.path.length - a.path.length);
  const out = new Map<string, StyleRow[]>();
  for (const c of diffMetadata(before, after)) {
    const e = catalog.find((e) => e.path.every((p, i) => c.path[i] === p));
    const [part, rest] = e
      ? [partLabel(e), c.path.slice(e.path.length).filter((p) => p !== "css")]
      : [
        SECTION_LABELS[c.path[0]!] ?? cap(words(c.path[0] ?? "")),
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

const RESTORES: {
  label: string;
  note: string;
  what: string;
  scope: (edition: string | null) => RestoreScope;
}[] = [
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
  if (otherEditionOnly(v, edition) && v.changes.editions.length === 1) {
    const ed = editionLabel(v.changes.editions[0]!, names);
    return `Only the ${ed} changed. The manuscript is shared, so its text is untouched.`;
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
  if (v.changes.text && styles) return "Text and styles changed";
  if (v.changes.text) return "Text changed";
  if (otherEditionOnly(v, edition) && v.changes.editions.length === 1) {
    return `${editionLabel(v.changes.editions[0]!, names)}: styles changed`;
  }
  if (styles) return "Styles changed";
  if (v.changes.images) return "Images changed";
  return "No changes";
}

export function createHistoryView(opts: {
  list: HTMLElement;
  changes: HTMLElement;
  backend: Backend;
  book: string;
  edition: string | null;
  onSelect(v: Version | "now"): void;
  onRestored(before: Version | null, label: string): void;
  onName(target: Version | "now"): void;
}): {
  refresh(): Promise<void>;
  select(id: string | "now"): void;
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
  const open = new Set<string>(); // folds expanded, by their first id
  const files = new Map<string, Promise<Record<string, string>>>();
  const diffs = new Map<string, Promise<VersionDiff>>();
  const parts = new Map<string, Map<string | null, string[]>>();

  const filesOf = (id: string) => {
    let p = files.get(id);
    if (!p) {
      p = backend.versionFiles(book, id).then((r) => r.files);
      files.set(id, p);
    }
    return p;
  };
  const prevOf = (v: Version) => versions[versions.indexOf(v) + 1];

  // The version against the one before it (all editions, not the filter's).
  const diffOf = (v: Version): Promise<VersionDiff> => {
    let p = diffs.get(v.id);
    if (p) return p;
    p = (async () => {
      const prev = prevOf(v);
      const [after, before] = await Promise.all([
        filesOf(v.id),
        prev ? filesOf(prev.id) : Promise.resolve({} as Record<string, string>),
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

  const rowButton = (
    id: string,
    time: string,
    head: string,
    detail: string,
    reason: string,
  ) => {
    const b = h(
      "button",
      {
        type: "button",
        class: "h-row",
        "data-id": id,
        "aria-pressed": String(id === selected),
      },
      h(
        "span",
        { class: "h-line" },
        h("span", { class: "h-time" }, time),
        h("span", { class: "h-head" }, head),
      ),
      h("span", { class: "h-detail" }, detail),
    );
    if (reason) b.append(h("span", { class: "h-reason" }, reason));
    b.onclick = () => {
      select(id);
      const v = versions.find((x) => x.id === id);
      opts.onSelect(v ?? "now");
    };
    return b;
  };

  const versionRow = (v: Version) => {
    const label = rowLabel(v, edition, { names, styleParts: parts.get(v.id) });
    const b = rowButton(
      v.id,
      timeLabel(new Date(v.at)),
      label.head,
      label.detail,
      reasonLabel(v),
    );
    // Part names need the files; fill them in once fetched.
    // ponytail: two versionFiles calls per style row, cached; a per-version
    // summary from the service if long histories feel slow.
    if (v.changes.editions.length && !parts.has(v.id)) {
      diffOf(v).then((d) => {
        parts.set(
          v.id,
          new Map(d.styles.map((s) => [s.edition, [...s.groups.keys()]])),
        );
        if (!alive || !b.isConnected) return;
        const l = rowLabel(v, edition, { names, styleParts: parts.get(v.id) });
        b.querySelector(".h-detail")!.textContent = l.detail;
      }, () => {});
    }
    return b;
  };

  const drawList = () => {
    const now = new Date();
    const days = groupVersions(versions, now, edition, filter);
    if (days[0]?.label !== "Today") days.unshift({ label: "Today", items: [] });
    const filterBtn = (f: Filter, label: string) => {
      const b = h("button", {
        type: "button",
        class: "btn",
        "aria-pressed": String(f === filter),
      }, label);
      b.onclick = () => {
        filter = f;
        const v = versions.find((x) => x.id === selected);
        if (v && !visible(v, edition, filter)) select("now");
        else drawList();
      };
      return b;
    };
    const body: Node[] = [
      h(
        "div",
        {
          class: "h-filter",
          role: "group",
          "aria-label": "Show versions from",
        },
        filterBtn("edition", "This edition"),
        filterBtn("all", "All editions"),
      ),
    ];
    days.forEach((day, i) => {
      body.push(h("div", { class: "h-day" }, day.label));
      if (i === 0) {
        body.push(
          rowButton(
            "now",
            "Now",
            "Current version",
            "Everything saved so far",
            "",
          ),
        );
      }
      for (const item of day.items) {
        if (!("fold" in item)) {
          body.push(versionRow(item));
          continue;
        }
        const key = item.fold[0]!.id;
        if (open.has(key) || item.fold.some((v) => v.id === selected)) {
          body.push(...item.fold.map(versionRow));
          continue;
        }
        const more = h("button", {
          type: "button",
          class: "btn h-more",
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

  let menuClose: (() => void) | null = null;
  const closeMenu = () => menuClose?.();

  const restoreMenu = (v: Version) => {
    const btn = h("button", {
      type: "button",
      class: "btn h-restore",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    }, "Restore ▾");
    const menu = h("div", { class: "h-menu choices", role: "menu" });
    menu.hidden = true;
    menu.append(...RESTORES.map((r) => {
      const item = h(
        "button",
        { type: "button", class: "choice", role: "menuitem" },
        r.label,
        h("small", {}, r.note),
      );
      item.onclick = async () => {
        closeMenu();
        const label = `${r.what} from ${whenLabel(v, new Date())}`;
        const before = await backend.restoreVersion(
          book,
          v.id,
          r.scope(edition),
        );
        if (!alive) return;
        opts.onRestored(before, label);
        selected = "now";
        await refresh();
      };
      return item;
    }));
    const onDoc = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !wrap.contains(e.target as Node)
      ) {
        closeMenu();
      }
    };
    menuClose = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onDoc);
      menuClose = null;
    };
    btn.onclick = () => {
      if (!menu.hidden) return closeMenu();
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onDoc);
      document.addEventListener("keydown", onDoc);
      (menu.firstElementChild as HTMLElement | null)?.focus();
    };
    const wrap = h("div", { class: "h-menu-wrap" }, btn, menu);
    return wrap;
  };

  let drawToken = 0;
  const drawChanges = () => {
    closeMenu();
    const token = ++drawToken;
    const v = versions.find((x) => x.id === selected);
    const nameBtn = h(
      "button",
      { type: "button", class: "btn h-name" },
      "Name…",
    );
    nameBtn.onclick = () => opts.onName(v ?? "now");
    if (!v) {
      changes.replaceChildren(
        h("h2", {}, "Current version"),
        h("div", { class: "h-actions" }, nameBtn),
        h(
          "p",
          { class: "h-summary" },
          "This is the book right now. Name it to keep a checkpoint, like “Sent to printer”.",
        ),
      );
      return;
    }
    const now = new Date();
    const reason = reasonLabel(v);
    const when = h("div", { class: "h-when" }, whenLabel(v, now));
    if (reason) when.append(" · ", h("i", {}, reason));
    const summary = summaryOf(v, edition, names);
    const body = h("div", { class: "h-diffs" });
    changes.replaceChildren(
      h("h2", {}, headingOf(v, edition, names)),
      when,
      h("div", { class: "h-actions" }, restoreMenu(v), nameBtn),
      ...(summary ? [h("p", { class: "h-summary" }, summary)] : []),
      body,
    );
    if (!v.changes.text && !v.changes.editions.length) return;
    body.append(h("p", { class: "h-note" }, "Loading changes…"));
    diffOf(v).then((d) => {
      if (token !== drawToken || !alive) return;
      const out: Node[] = [];
      for (const s of d.styles) {
        const prefix = s.edition === edition
          ? ""
          : `${editionLabel(s.edition, names)} · `;
        for (const [part, rows] of s.groups) {
          out.push(h(
            "section",
            { class: "h-group" },
            h("div", { class: "h-part" }, prefix + part),
            ...rows.map((r) =>
              h(
                "div",
                { class: "h-style" },
                h("span", { class: "h-prop" }, r.prop),
                h(
                  "span",
                  {},
                  h("span", { class: "h-from" }, r.from),
                  " → ",
                  h("b", {}, r.to),
                ),
              )
            ),
          ));
        }
      }
      for (const c of d.text) {
        out.push(h(
          "section",
          { class: "h-group" },
          h("div", { class: "h-part" }, chaptersLabel([c.chapter])),
          ...c.paras.map((p) =>
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
        out.push(
          h(
            "p",
            { class: "h-note" },
            "Select any text to copy it. Nothing changes until you restore.",
          ),
        );
      }
      body.replaceChildren(...out);
    }, (err) => {
      if (token !== drawToken || !alive) return;
      body.replaceChildren(
        h(
          "p",
          { class: "h-note h-err" },
          `Couldn’t load the changes: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
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
    destroy() {
      alive = false;
      closeMenu();
      list.replaceChildren();
      changes.replaceChildren();
      list.classList.remove("history-list");
      changes.classList.remove("history-changes");
    },
  };
}
