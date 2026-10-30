// web/src/undo.ts — the toolbar's Undo and Redo. Write undoes the text
// (CodeMirror's history), Style and Publish the styles (StyleUndo).
import type { EditorView } from "@codemirror/view";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { $ } from "./dom.ts";
import type { Mode } from "./preview.ts";

export interface UndoDeps {
  mode(): Mode;
  editor(): EditorView;
  styles: {
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): void;
    redo(): void;
  };
}

export interface Undo {
  /** Enables the buttons for what can be undone now. */
  refresh(): void;
}

export function installUndo(d: UndoDeps): Undo {
  const undoB = $("undo") as HTMLButtonElement;
  const redoB = $("redo") as HTMLButtonElement;
  const text = () => d.mode() === "write";
  const refresh = () => {
    const ed = d.editor();
    undoB.disabled = text() ? !undoDepth(ed.state) : !d.styles.canUndo();
    redoB.disabled = text() ? !redoDepth(ed.state) : !d.styles.canRedo();
  };
  const step = (back: boolean) => () => {
    if (text()) {
      const ed = d.editor();
      (back ? undo : redo)(ed);
      ed.focus(); // a writer clicks Undo and goes on typing
    } else (back ? d.styles.undo : d.styles.redo)();
    refresh();
  };
  undoB.onclick = step(true);
  redoB.onclick = step(false);
  refresh();
  return { refresh };
}
