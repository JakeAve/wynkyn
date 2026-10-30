// web/src/panel-parts.ts — the style panel's Book parts tab (spec R1, R2, R4):
// a detail view per part with one section per sub-element,
// and Body text's own view (text, paragraphs, emphasis). Page furniture
// parts are built in panel-furniture.ts.
import type {
  Metadata,
  NumberingStyle,
  StructureNumbering,
} from "../../metadata/types.ts";
import { matterType } from "../../parser/types.ts";
import { caseOf, caseProps, emphasisOf, parseLength } from "./config-data.ts";
import { buildFurniture } from "./panel-furniture.ts";
import {
  addNew,
  applies,
  caseSeg,
  colorPick,
  emphasisToggles,
  icon,
  makeView,
  moreCss,
  row,
  section,
  seg,
  select,
  stepper,
  switchInput,
  type View,
} from "./panel-controls.ts";
import {
  type BookPart,
  bookParts,
  catalogFor,
  ensureProps,
  getProps,
  inheritedFont,
  inheritedValue,
  type PanelContext,
  setCount,
  type StyleEntry,
} from "./style-catalog.ts";

type Section = keyof Metadata;

export function buildPartsTab(ctx: PanelContext, part?: string): Node[] {
  const p = part ? bookParts(ctx.meta).find((x) => x.id === part) : undefined;
  if (!p) return pickTip();
  if (p.id === "folios" || p.id === "heads") return buildFurniture(ctx, p.id);
  if (p.group === "custom") return isDetail(ctx, p);
  return p.id === "body" ? bodyDetail(ctx, p) : detail(ctx, p);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  if (e instanceof HTMLButtonElement) e.type = "button";
  return e;
}

const cap = (s: string) =>
  s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// No part chosen: the nav lists them.
function pickTip(): Node[] {
  return [el(
    "p",
    "tip",
    el("span", "manicule", "☞"),
    "Pick a part, or click anything in the preview to jump straight to its settings.",
  )];
}

// ---- writing ----

// The object at entry.path, or undefined — never creates anything.
function liveAt(
  meta: Metadata,
  entry: StyleEntry,
): Record<string, unknown> | undefined {
  let node: unknown = meta;
  for (const p of entry.path) {
    node = node && typeof node === "object"
      ? (node as Record<string, unknown>)[p]
      : undefined;
  }
  return node && typeof node === "object"
    ? node as Record<string, unknown>
    : undefined;
}

// Set a prop on the entry; empty deletes it.
function put(
  meta: Metadata,
  entry: StyleEntry,
  prop: string,
  value: string | undefined,
): void {
  if (value) ensureProps(meta, entry)[prop] = value;
  else delete liveAt(meta, entry)?.[prop];
}

function clear(meta: Metadata, entry: StyleEntry, keys: string[]): void {
  const live = liveAt(meta, entry);
  if (live) { for (const k of keys) delete live[k]; }
}

// "More CSS" hands back every prop that has no control; swap those in.
function replaceOthers(
  meta: Metadata,
  entry: StyleEntry,
  controlled: string[],
  next: Record<string, string>,
): void {
  const live = ensureProps(meta, entry);
  for (const [k, v] of Object.entries(live)) {
    if (typeof v === "string" && !controlled.includes(k) && !(k in next)) {
      delete live[k];
    }
  }
  Object.assign(live, next);
}

function footer(
  count: HTMLElement,
  onReset: () => void,
): HTMLElement {
  const reset = el("button", "ghost", icon("reset"), "Reset to inherited");
  reset.onclick = onReset;
  return el("div", "foot", count, reset);
}

// ---- detail ----

const GENERIC = [
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-decoration",
  "text-transform",
  "font-variant-caps",
  "color",
  "text-align",
  "letter-spacing",
  "line-height",
  "margin-top",
  "margin-bottom",
];

const LABELS: Record<string, string> = {
  "verses.number": "Verse numbers",
  copyright: "Whole page",
  "copyright.isbn": "ISBN",
};

function labelOf(entry: StyleEntry, part: BookPart): string {
  const own = LABELS[entry.key];
  if (own) return own;
  if (entry.key.includes(".")) return entry.label;
  if (part.keys.length < 2) return "Text";
  return entry.label === "Everything" ? cap(entry.key) : entry.label;
}

// The section's data-focus: the sub-element ("number"), or a flat type itself.
// `{is}` classes are one-offs: a CSS box, no controls.
function isDetail(ctx: PanelContext, part: BookPart): Node[] {
  const { meta } = ctx;
  const entry = catalogFor(meta).find((e) => e.key === part.keys[0])!;
  const box = moreCss(`CSS for ${part.name}`, getProps(meta, entry), (next) => {
    replaceOthers(meta, entry, [], next);
    ctx.queueSave("is");
  }, []);
  box.open = true;
  const where = applies(ctx, entry.key); // the header shows it
  return where ? [box, where] : [box];
}

function focusOf(key: string): string {
  const type = key.split(".")[0]!;
  return key.slice(type.length + 1) || type;
}

function detail(ctx: PanelContext, part: BookPart): Node[] {
  const { meta } = ctx;
  const catalog = new Map(catalogFor(meta).map((e) => [e.key, e]));
  const entries = part.keys.flatMap((k) => catalog.get(k) ?? []);
  // Openers read number then title, as on the page (the catalog has title first).
  if (part.id === "chapter" || part.id === "part") entries.reverse();
  const count = el("span", "from");
  const recount = () =>
    count.textContent = `${
      plural(setCount(meta, part), "setting")
    } in this book`;
  const v = makeView(ctx, recount);
  const resets: Array<() => Section[]> = [];
  const page = part.group !== "body" && matterType(part.id).display
    ? onePage(ctx, v, part.id)
    : null;
  if (page) resets.push(page.reset);
  const blocks = entries.map((entry) => {
    const x = extrasFor(ctx, v, entry);
    const rows = page && entry.key === part.id
      ? [page.row, ...x?.rows ?? []]
      : x?.rows;
    const controlled = [...GENERIC, ...(x?.controlled ?? [])];
    resets.push(() => {
      clear(meta, entry, controlled);
      return [entry.section, ...(x?.reset?.() ?? [])];
    });
    return block(ctx, v, entry, labelOf(entry, part), controlled, rows);
  });
  recount();
  return [
    ...(page && !entries.some((e) => e.key === part.id)
      ? [section("Whole page", part.id, [page.row])]
      : []),
    ...blocks,
    footer(count, () => {
      for (const s of new Set(resets.flatMap((f) => f()))) ctx.queueSave(s);
      ctx.go({ tab: "parts", part: part.id });
    }),
  ];
}

const ALIGNS = [
  { icon: "alignL", value: "left", aria: "Left" },
  { icon: "alignC", value: "center", aria: "Center" },
  { icon: "alignR", value: "right", aria: "Right" },
  { icon: "alignJ", value: "justify", aria: "Justified" },
];

function block(
  ctx: PanelContext,
  v: View,
  entry: StyleEntry,
  label: string,
  controlled: string[],
  extraRows: HTMLElement[] = [],
): HTMLElement {
  const { meta } = ctx;
  const props = getProps(meta, entry);
  const has = (...ps: string[]) => () => {
    const now = getProps(meta, entry);
    return ps.some((p) => p in now);
  };
  const save = () => v.changed(entry.section);
  const set = (prop: string) => (value: string | undefined) => {
    put(meta, entry, prop, value);
    save();
  };
  const body = getProps(meta, { path: ["elements", "body"] });

  const fonts = meta.fonts ?? {};
  const ff = props["font-family"];
  const fontOpts = [
    { label: `Inherited · ${inheritedFont(meta, entry)}`, value: "" },
    ...Object.entries(fonts).map(([a, f]) => ({
      label: `${cap(a)} · ${f}`,
      value: a,
    })),
  ];
  if (ff && !(ff in fonts)) fontOpts.push({ label: ff, value: ff });

  const inhAlign = `Inherited · ${
    body["text-align"] === "justify" ? "justified" : "left"
  }`;
  const alignRow = row(
    "Align",
    seg(
      ALIGNS,
      props["text-align"],
      (a) => {
        from.textContent = a ? "" : inhAlign;
        set("text-align")(a);
      },
      `${label} alignment`,
      true,
    ),
    { note: inhAlign },
  );
  const from = alignRow.querySelector(".from")!;
  if (props["text-align"]) from.textContent = "";

  // Spacing may go negative (tighten, pull up); sizes may not.
  const length = (lbl: string, prop: string, placeholder: string) =>
    v.mark(
      row(
        lbl,
        stepper({
          value: props[prop],
          placeholder,
          label: `${label} ${lbl.toLowerCase()}`,
          unit: parseLength(placeholder)?.unit,
          allowNegative: true,
          onChange: set(prop),
        }),
      ),
      has(prop),
    );

  // The book's colors (§4.15) by name, like the fonts: changing one
  // recolors its users. The chip shows the color the text sets in now.
  const colorRow = row(
    "Color",
    colorPick(
      ctx,
      props.color,
      inheritedValue(meta, entry, "color"),
      set("color"),
      `${label} color`,
    ),
  );

  return section(label, focusOf(entry.key), [
    ...extraRows,
    v.mark(
      row(
        "Font",
        el(
          "span",
          "ctl",
          select(
            fontOpts,
            ff ?? "",
            (x) => set("font-family")(x || undefined),
            `${label} font`,
          ),
          addNew(ctx, "font"),
        ),
      ),
      has("font-family"),
    ),
    v.mark(
      row(
        "Size",
        stepper({
          value: props["font-size"],
          placeholder: body["font-size"],
          label: `${label} size`,
          onChange: set("font-size"),
        }),
      ),
      has("font-size"),
    ),
    v.mark(
      row(
        "Style",
        el(
          "span",
          "ctl",
          ...emphasisToggles(emphasisOf(props), (p, x) => set(p)(x)),
          caseSeg(caseOf(props), (c) => {
            for (const [k, x] of Object.entries(caseProps(c))) {
              put(meta, entry, k, x);
            }
            save();
          }, `${label} case`),
        ),
      ),
      has(
        "font-style",
        "font-weight",
        "text-decoration",
        "text-transform",
        "font-variant-caps",
      ),
    ),
    v.mark(colorRow, has("color")),
    v.mark(alignRow, has("text-align")),
    length("Letter spacing", "letter-spacing", "0em"),
    // Leading as a multiple of the size (1.2), like Body text's; unset, the
    // inherited spacing shows.
    v.mark(
      row(
        "Line spacing",
        stepper({
          value: props["line-height"],
          placeholder: inheritedValue(meta, entry, "line-height") ?? "1.5",
          label: `${label} line spacing`,
          unit: "",
          step: () => 0.05,
          onChange: set("line-height"),
        }),
      ),
      has("line-height"),
    ),
    length("Space above", "margin-top", "0pt"),
    length("Space below", "margin-bottom", "0pt"),
    moreCss(
      `More CSS for ${label.toLowerCase()}`,
      props,
      (next) => {
        replaceOthers(meta, entry, controlled, next);
        save();
      },
      controlled,
    ),
  ], applies(ctx, entry.key));
}

// ---- extras: numbering, ornament, note placement ----

interface Extra {
  rows: HTMLElement[];
  controlled?: string[]; // entry props the extra rows own
  reset?(): Section[]; // clear what the rows own outside the entry
}

const NUMERALS: Array<{ value: NumberingStyle; label: string; aria: string }> =
  [
    { label: "1", value: "arabic", aria: "1, 2, 3" },
    { label: "I", value: "roman-upper", aria: "I, II, III" },
    { label: "i", value: "roman-lower", aria: "i, ii, iii" },
    { label: "One", value: "words", aria: "One, Two, Three" },
    { label: "First", value: "ordinal", aria: "First, Second, Third" },
  ];

function onePage(ctx: PanelContext, v: View, type: string) {
  const { meta } = ctx;
  const cur = () => meta["one-page"]?.[type];
  return {
    row: v.mark(
      row(
        "One page",
        switchInput(
          "Keep to one page; cut what runs past it",
          cur() ?? true,
          (on) => {
            (meta["one-page"] ??= {})[type] = on;
            v.changed("one-page");
          },
        ),
      ),
      () => cur() !== undefined,
    ),
    reset(): Section[] {
      if (cur() === undefined) return [];
      delete meta["one-page"]![type];
      if (!Object.keys(meta["one-page"]!).length) delete meta["one-page"];
      return ["one-page"];
    },
  };
}

function extrasFor(
  ctx: PanelContext,
  v: View,
  entry: StyleEntry,
): Extra | undefined {
  const { meta } = ctx;
  const which = entry.key === "chapter.number"
    ? "chapters"
    : entry.key === "part.number"
    ? "parts"
    : undefined;
  if (which) {
    const cfg = () => meta.numbering?.[which];
    const edit = (f: (c: StructureNumbering) => void) => {
      f((meta.numbering ??= {})[which] ??= {});
      v.changed("numbering");
    };
    const cur = cfg() ?? {};
    const lab = el("input", "txt");
    lab.type = "text";
    lab.value = cur.prefix ?? "";
    lab.setAttribute("aria-label", "Label before the number");
    lab.oninput = () => edit((c) => c.prefix = lab.value);
    // Raw like the prefix: a trailing space or full stop is the point.
    const suf = el("input", "txt");
    suf.type = "text";
    suf.value = cur.suffix ?? "";
    suf.setAttribute("aria-label", "Text after the number");
    suf.oninput = () => edit((c) => c.suffix = suf.value);
    const sample = (s: NumberingStyle | undefined) =>
      NUMERALS.find((n) => n.value === (s ?? "arabic"))?.label ?? "1";
    const num = el("span", "from", sample(cur.style));
    return {
      rows: [
        v.mark(
          row(
            "Numerals",
            seg(
              NUMERALS,
              cur.style ?? "arabic",
              (s) => {
                num.textContent = sample(s);
                edit((c) => c.style = s ?? "arabic");
              },
              "Numerals",
            ),
          ),
          () => cfg()?.style !== undefined,
        ),
        v.mark(
          row(
            "Show",
            switchInput(
              "Show the number",
              cur.show ?? true,
              (on) => edit((c) => c.show = on),
            ),
          ),
          () => cfg()?.show !== undefined,
        ),
        v.mark(
          row("Label", el("span", "ctl", lab, num, suf)),
          () => cfg()?.prefix !== undefined || cfg()?.suffix !== undefined,
        ),
      ],
      reset() {
        const c = cfg();
        if (!c) return [];
        delete c.style;
        delete c.prefix;
        delete c.suffix;
        delete c.show;
        if (!Object.keys(c).length) delete meta.numbering![which];
        return ["numbering"];
      },
    };
  }
  if (entry.key === "chapter.book-title") {
    return {
      rows: [v.mark(
        row(
          "Show",
          switchInput(
            "Show the book's title above the first chapter",
            meta.openers?.["book-title"] ?? false,
            (on) => {
              (meta.openers ??= {})["book-title"] = on;
              v.changed("openers");
            },
          ),
        ),
        () => meta.openers?.["book-title"] !== undefined,
      )],
      reset() {
        if (meta.openers?.["book-title"] === undefined) return [];
        delete meta.openers["book-title"];
        return ["openers"];
      },
    };
  }
  if (entry.key === "break") {
    const o = el("input", "txt");
    o.type = "text";
    o.value = getProps(meta, entry).content ?? "";
    o.setAttribute("aria-label", "Break ornament");
    o.style.cssText = "width:5rem;text-align:center";
    o.oninput = () => {
      put(meta, entry, "content", o.value || undefined);
      v.changed(entry.section);
    };
    return {
      rows: [
        v.mark(row("Ornament", o), () => "content" in getProps(meta, entry)),
      ],
      controlled: ["content"],
    };
  }
  if (entry.key === "copyright") {
    // base.css stacks the page at the foot; Bottom stores nothing.
    const cur = getProps(meta, entry)["justify-content"];
    return {
      rows: [v.mark(
        row(
          "On the page",
          seg(
            [
              { label: "Top", value: "flex-start" },
              { label: "Middle", value: "center" },
              { label: "Bottom", value: "flex-end" },
            ],
            cur ?? "flex-end",
            (j) => {
              put(
                meta,
                entry,
                "justify-content",
                j === "flex-end" ? undefined : j,
              );
              v.changed(entry.section);
            },
            "Copyright position on the page",
          ),
        ),
        () => "justify-content" in getProps(meta, entry),
      )],
      controlled: ["justify-content"],
    };
  }
  if (entry.key === "footnote") {
    return {
      rows: [v.mark(
        row(
          "Place notes",
          seg(
            [
              { label: "Page foot", value: "footnote" },
              { label: "Chapter end", value: "endnote" },
            ],
            meta.notes?.placement ?? "footnote",
            (p) => {
              (meta.notes ??= {}).placement = p ?? "footnote";
              v.changed("notes");
            },
            "Note placement",
          ),
        ),
        () => meta.notes?.placement !== undefined,
      )],
      reset() {
        if (meta.notes?.placement === undefined) return [];
        delete meta.notes.placement;
        return ["notes"];
      },
    };
  }
  return undefined;
}

// ---- Body text ----

// The book's language (spec §4.2) picks the hyphenation rules and the EPUB's
// dc:language. Any BCP 47 tag works; Other… takes one the list lacks.
const LANGUAGES = [
  { label: "English", value: "en" },
  { label: "Spanish", value: "es" },
  { label: "Portuguese", value: "pt" },
  { label: "French", value: "fr" },
  { label: "German", value: "de" },
  { label: "Italian", value: "it" },
  { label: "Dutch", value: "nl" },
];

function languageControl(ctx: PanelContext, v: View): HTMLElement {
  const { meta } = ctx;
  const cur = meta.language ?? meta.ebook?.language ?? "en";
  const listed = LANGUAGES.some((l) => l.value === cur);
  const code = el("input", "");
  code.type = "text";
  code.value = listed ? "" : cur;
  code.placeholder = "e.g. ca";
  code.setAttribute("aria-label", "Language code");
  code.hidden = listed;
  const set = (tag: string) => {
    meta.language = tag;
    v.changed("language");
  };
  code.onchange = () => {
    const t = code.value.trim();
    if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(t)) set(t);
    else code.value = meta.language ?? "";
  };
  const pick = select(
    [...LANGUAGES, { label: "Other…", value: "" }],
    listed ? cur : "",
    (x) => {
      code.hidden = x !== "";
      if (x) set(x);
      else code.focus();
    },
    "Language",
  );
  return el("span", "ctl", pick, code);
}

type Sep = "indent" | "space" | "both";
const isZero = (x: string | undefined) => !x || parseFloat(x) === 0;

function bodyDetail(ctx: PanelContext, part: BookPart): Node[] {
  const { meta } = ctx;
  const catalog = new Map(catalogFor(meta).map((e) => [e.key, e]));
  const body = catalog.get("body")!;
  const para = catalog.get("paragraph")!;
  const em = catalog.get("em")!;
  const count = el("span", "from");
  const recount = () =>
    count.textContent = `${
      plural(setCount(meta, part), "setting")
    } in this book`;
  let syncSep = () => {};
  const v = makeView(ctx, () => {
    recount();
    syncSep();
  });
  const has = (entry: StyleEntry, ...ps: string[]) => () => {
    const now = getProps(meta, entry);
    return ps.some((p) => p in now);
  };
  const save = () => v.changed("elements");

  // Text
  const bp = getProps(meta, body);
  const ff = bp["font-family"];
  const change = el("button", "where", "Change in Fonts");
  change.onclick = () => ctx.go({ tab: "fonts", focus: ff ?? "body" });
  const text = section("Text", "text", [
    row(
      "Font",
      el(
        "span",
        "ctl",
        el("span", "", ff ? meta.fonts?.[ff] ?? ff : "serif"),
        change,
      ),
    ),
    v.mark(
      row(
        "Size",
        stepper({
          value: bp["font-size"],
          placeholder: "12pt",
          label: "Body text size",
          onChange: (x) => {
            put(meta, body, "font-size", x);
            save();
          },
        }),
      ),
      has(body, "font-size"),
    ),
    v.mark(
      // As every part's: a multiple of the size; base.css's 1.5 unset.
      row(
        "Line spacing",
        stepper({
          value: bp["line-height"],
          placeholder: "1.5",
          label: "Body text line spacing",
          unit: "",
          step: () => 0.05,
          onChange: (x) => {
            put(meta, body, "line-height", x);
            save();
          },
        }),
      ),
      has(body, "line-height"),
    ),
    v.mark(
      row(
        "Alignment",
        seg(
          [
            { label: "Justified", value: "justify" },
            { label: "Left", value: "left" },
          ],
          bp["text-align"] ?? "left",
          (a) => {
            put(meta, body, "text-align", a);
            save();
          },
          "Alignment",
        ),
      ),
      has(body, "text-align"),
    ),
    v.mark(
      row(
        "Hyphenation",
        switchInput("Hyphenation", bp["hyphens"] === "auto", (on) => {
          put(meta, body, "hyphens", on ? "auto" : "manual");
          save();
        }),
      ),
      has(body, "hyphens"),
    ),
    v.mark(
      row("Language", languageControl(ctx, v)),
      () => meta.language !== undefined,
    ),
  ], el("span", "from", "Every page"));

  // Paragraphs: an indent is on unless text-indent is 0 (unset inherits
  // base.css's 1.5em); space is on when margin-top (in lines) isn't 0. Indent
  // / Space / Both follow from the two; neither on selects nothing. Space and
  // Both remember the last space set; Indent and Both the last indent.
  const SEPS: Array<{ label: string; value: Sep }> = [
    { label: "Indent", value: "indent" },
    { label: "Space", value: "space" },
    { label: "Both", value: "both" },
  ];
  const sepOf = (): Sep | undefined => {
    const p = getProps(meta, para);
    const i = p["text-indent"] === undefined || !isZero(p["text-indent"]);
    const s = !isZero(p["margin-top"]);
    return i && s ? "both" : i ? "indent" : s ? "space" : undefined;
  };
  const pp = getProps(meta, para);
  let indent = isZero(pp["text-indent"]) ? undefined : pp["text-indent"];
  let space = isZero(pp["margin-top"]) ? "0.5lh" : pp["margin-top"]!;
  let sep = sepOf();
  const indentRow = () =>
    v.mark(
      row(
        "First-line indent",
        stepper({
          value: indent,
          placeholder: "1.5em",
          label: "First-line indent",
          unit: "em",
          onChange: (x) => {
            indent = x;
            put(meta, para, "text-indent", x);
            save();
          },
        }),
        { hidden: sep === "space" },
      ),
      has(para, "text-indent"),
    );
  const spaceRow = () =>
    v.mark(
      row(
        "Space between",
        stepper({
          value: isZero(getProps(meta, para)["margin-top"]) ? undefined : space,
          placeholder: "0.5lh",
          label: "Space between paragraphs",
          unit: "lh",
          onChange: (x) => {
            if (x && !isZero(x)) space = x;
            put(meta, para, "margin-top", x);
            save();
          },
        }),
        { hidden: sep === "indent" },
      ),
      has(para, "margin-top"),
    );
  let iRow = indentRow();
  let sRow = spaceRow();
  const sepSeg = seg<Sep>(
    SEPS,
    sep,
    (s) => {
      sep = s;
      put(meta, para, "text-indent", sep === "space" ? "0" : indent);
      put(meta, para, "margin-top", sep === "indent" ? undefined : space);
      const [a, b] = [indentRow(), spaceRow()];
      iRow.replaceWith(a);
      sRow.replaceWith(b);
      [iRow, sRow] = [a, b];
      save();
    },
    "Separate paragraphs by",
  );
  // A stepper edit can turn one of the two off: the segment follows.
  syncSep = () => {
    const now = sepOf();
    sepSeg.querySelectorAll("[role=radio]").forEach((b, i) =>
      b.setAttribute("aria-checked", String(SEPS[i]?.value === now))
    );
  };
  const paraControlled = ["text-indent", "margin-top"];
  const paragraphs = section("Paragraphs", "paragraphs", [
    v.mark(
      row("Separate by", sepSeg),
      has(para, ...paraControlled),
    ),
    iRow,
    sRow,
    el(
      "p",
      "hint",
      "The first paragraph after a title, drop cap or break always starts flush.",
    ),
    moreCss("More CSS for paragraphs", pp, (next) => {
      replaceOthers(meta, para, paraControlled, next);
      save();
    }, paraControlled),
  ], applies(ctx, "paragraph"));

  // Emphasis
  const ep = getProps(meta, em);
  const emKeys = ["font-style", "font-weight", "font-variant-caps"];
  const emphasis = section("Emphasis", "emphasis", [
    v.mark(
      row(
        "Style",
        seg(
          [
            { label: "Italic", value: "italic" },
            { label: "Bold", value: "bold" },
            { label: "Small caps", value: "smallcaps" },
          ],
          ep["font-variant-caps"]?.includes("small-caps")
            ? "smallcaps"
            : ["bold", "700"].includes(ep["font-weight"] ?? "")
            ? "bold"
            : "italic",
          (s) => {
            put(meta, em, "font-style", s === "italic" ? "italic" : "normal");
            put(meta, em, "font-weight", s === "bold" ? "bold" : undefined);
            put(
              meta,
              em,
              "font-variant-caps",
              s === "smallcaps" ? "all-small-caps" : undefined,
            );
            save();
          },
          "Emphasis style",
        ),
      ),
      has(em, ...emKeys),
    ),
  ]);

  recount();
  return [
    text,
    paragraphs,
    emphasis,
    footer(count, () => {
      clear(meta, body, ["font-size", "line-height", "text-align", "hyphens"]);
      clear(meta, para, paraControlled);
      clear(meta, em, emKeys);
      ctx.queueSave("elements");
      delete meta.language;
      ctx.queueSave("language");
      ctx.go({ tab: "parts", part: part.id });
    }),
  ];
}
