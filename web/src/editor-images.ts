// web/src/editor-images.ts — image files dropped or pasted on the editor go in
// the book's images/ and come back as `{illustration: slug}` blocks at the
// nearest paragraph break; in the slug of an illustration or a dropcap image,
// completions list them (spec §7.3).
import {
  closeCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { type ImageFile, imageSlug } from "../../server/images.ts";
import type { CellCompletion } from "./editor-insert.ts";

/** What the editor needs from the app to keep a book's images. */
export interface ImageHost {
  images(): Promise<ImageFile[]>;
  url(name: string): Promise<string>;
  add(file: File, slug?: string): Promise<ImageFile>;
  note(text: string, warn?: boolean): void;
}

const REFUSED = "Only PNG, JPEG, WebP or SVG images can go in a book";

/** The paragraph break nearest `pos`: a blank line, or the start or end of
 * the paragraph `pos` is in, whichever is closer. `endOnly` (a paste) always
 * takes the end. */
export function breakNear(doc: Text, pos: number, endOnly = false): number {
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return line.from;
  let first = line, last = line;
  while (first.number > 1 && doc.line(first.number - 1).text.trim()) {
    first = doc.line(first.number - 1);
  }
  while (last.number < doc.lines && doc.line(last.number + 1).text.trim()) {
    last = doc.line(last.number + 1);
  }
  return endOnly || last.to - pos <= pos - first.from ? last.to : first.from;
}

/** The text to insert at `at` for these image slugs, with a blank line on
 * each side, and where the first block's `Caption` starts in it. */
export function illustrationBlocks(
  doc: Text,
  at: number,
  slugs: string[],
): { insert: string; caption: number } {
  const newlines = (s: string) => (s.match(/\n/g) ?? []).length;
  const before = doc.sliceString(0, at);
  const after = doc.sliceString(at);
  const pre = before.trim()
    ? "\n".repeat(Math.max(0, 2 - newlines(before.match(/\s*$/)![0])))
    : "";
  const post = after.trim()
    ? "\n".repeat(Math.max(0, 2 - newlines(after.match(/^\s*/)![0])))
    : "\n";
  const blocks = slugs.map((s) => `{illustration: ${s}}\nCaption`);
  const head = `{illustration: ${slugs[0]}}\n`;
  return {
    insert: pre + blocks.join("\n\n") + post,
    caption: pre.length + head.length,
  };
}

// ---- the drop line: where a dragged file would land ----

const setDropAt = StateEffect.define<number | null>();

class DropLine extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const d = document.createElement("div");
    d.className = "cm-image-drop";
    const label = document.createElement("span");
    label.textContent = "Drop to add an illustration here";
    d.append(label);
    return d;
  }
}

const dropLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDropAt)) continue;
      if (e.value === null) return Decoration.none;
      const line = tr.state.doc.lineAt(e.value);
      // At a line's end the line sits below it, else above it.
      const side = e.value === line.to && line.text.trim() ? 1 : -1;
      return Decoration.set(
        Decoration.widget({ widget: new DropLine(), block: true, side })
          .range(e.value),
      );
    }
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const dropAt = (view: EditorView): number | null => {
  const it = view.state.field(dropLine).iter();
  return it.value ? it.from : null;
};

function showDrop(view: EditorView, at: number | null): void {
  if (dropAt(view) !== at) view.dispatch({ effects: setDropAt.of(at) });
}

function breakAtCoords(view: EditorView, e: DragEvent): number {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
  return breakNear(view.state.doc, pos);
}

const hasFiles = (dt: DataTransfer | null) =>
  !!dt && [...dt.types].includes("Files");

// Saves each file in order; the ones that went in become one transaction of
// blocks at the paragraph break nearest `pos`, the first Caption selected.
async function addImages(
  view: EditorView,
  host: ImageHost,
  files: File[],
  pos: number,
  endOnly: boolean,
): Promise<void> {
  const added: ImageFile[] = [];
  let refusal = "";
  for (const file of files) {
    if (!imageSlug(file.name)) {
      refusal = REFUSED;
      continue;
    }
    try {
      added.push(await host.add(file));
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }
  }
  if (added.length) {
    // The doc may have moved on while the files saved; clamp, don't map.
    const doc = view.state.doc;
    const at = breakNear(doc, Math.min(pos, doc.length), endOnly);
    const { insert, caption } = illustrationBlocks(
      doc,
      at,
      added.map((f) => f.slug),
    );
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + caption, head: at + caption + 7 },
      scrollIntoView: true,
      userEvent: endOnly ? "input.paste" : "input.drop",
    });
    view.focus();
  }
  if (refusal) host.note(refusal, true);
  else if (added.length) {
    host.note(
      `Added to the book's images as ${added.map((f) => f.name).join(", ")}`,
    );
  }
}

/** Drop and paste of image files, ahead of CodeMirror's own handlers; a drag
 * or paste without files (moving text) is left to CodeMirror. */
export function imageExtensions(host: ImageHost): Extension[] {
  return [
    dropLine,
    Prec.highest(EditorView.domEventHandlers({
      dragover(e, view) {
        if (!hasFiles(e.dataTransfer)) return false;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        showDrop(view, breakAtCoords(view, e));
        return true;
      },
      dragleave(e, view) {
        if (!view.dom.contains(e.relatedTarget as Node | null)) {
          showDrop(view, null);
        }
        return false;
      },
      drop(e, view) {
        const files = [...e.dataTransfer?.files ?? []];
        showDrop(view, null);
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        addImages(view, host, files, pos, false);
        return true;
      },
      paste(e, view) {
        const files = [...e.clipboardData?.files ?? []];
        if (!files.length) return false;
        e.preventDefault();
        addImages(view, host, files, view.state.selection.main.head, true);
        return true;
      },
    })),
  ];
}

// ---- completions: the book's images in a slug, placements after `placement:`

const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";
const SECTION = { name: "Images in this book", rank: 0 };
// Only the placements that lay out today.
const PLACEMENTS: CellCompletion[] = [
  { label: "full-page", detail: "a page of its own" },
  { label: "inline", detail: "in the text" },
];

function thumb(host: ImageHost, name: string): () => Node {
  return () => {
    const img = document.createElement("img");
    img.className = "cm-bml-thumb";
    img.alt = "";
    host.url(name).then((u) => img.src = u, () => {});
    return img;
  };
}

function addCell(): Node {
  const s = document.createElement("span");
  s.className = "cm-bml-thumb add";
  s.textContent = "+";
  return s;
}

// Opens the file picker; the picked file goes in images/ and its slug at
// from–to (clamped: the doc may have moved on while it saved).
function pickImage(
  view: EditorView,
  host: ImageHost,
  from: number,
  to: number,
) {
  closeCompletion(view);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { slug } = await host.add(file);
      const len = view.state.doc.length;
      const at = Math.min(from, len);
      view.dispatch({
        changes: { from: at, to: Math.min(to, len), insert: slug },
        selection: { anchor: at + slug.length },
        userEvent: "input.complete",
      });
      view.focus();
    } catch (err) {
      host.note(err instanceof Error ? err.message : String(err), true);
    }
  };
  input.click();
}

/** In `{illustration: …}` or `{dropcap | image: …}`, the book's images (a
 * thumbnail, the slug, "Not in the text yet" for those no tag names) and a
 * row that adds one from the computer; after `placement:` in an illustration,
 * the placements. */
export function imageCompletions(host: ImageHost): CompletionSource {
  return async (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const place = /\{illustration\b[^}]*\bplacement:\s*([\w-]*)$/.exec(before);
    if (place) {
      return {
        from: ctx.pos - place[1]!.length,
        validFor: /^[\w-]*$/,
        options: PLACEMENTS,
      };
    }
    const m = /(?:\{illustration:|\{dropcap\b[^}]*\bimage:)\s*([\w-]*)$/
      .exec(before);
    if (!m) return null;
    const typed = m[1]!;
    const used = new Set(
      [
        ...ctx.state.doc.toString().matchAll(
          /(?:\{illustration:|\bimage:)\s*([\w-]+)/g,
        ),
      ].map((u) => u[1]),
    );
    const images = await host.images();
    const options: CellCompletion[] = images
      .filter((i) => i.slug.includes(typed))
      .map((i) => ({
        label: i.slug,
        detail: used.has(i.slug) ? undefined : "Not in the text yet",
        section: SECTION,
        cell: thumb(host, i.name),
      }));
    options.push({
      label: "Add image from your computer…",
      detail: "Copies it into the book's images folder",
      section: SECTION,
      cell: addCell,
      apply: (view, _c, from, to) => pickImage(view, host, from, to),
    });
    // The add row stays whatever is typed, so this source filters itself.
    return { from: ctx.pos - typed.length, filter: false, options };
  };
}
