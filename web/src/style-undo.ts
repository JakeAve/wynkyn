// web/src/style-undo.ts — undo and redo for style edits this session: one
// step per edit, over the whole sections a save replaces. Pure; app.ts feeds
// it every metadata save and applies what it hands back.
import type { Metadata } from "../../metadata/types.ts";

type Sections = Record<string, unknown>;
interface Step {
  before: Sections; // undefined: the section was absent
  after: Sections;
  view: string;
  at: number;
}

export interface StyleStep {
  metadata: Metadata;
  sections: Partial<Metadata>; // to save; null deletes a section
  view: string;
}

// A stepper clicked or a number typed is many saves of one section; this
// close together they undo as one.
const GROUP_MS = 1000;

export class StyleUndo {
  #saved: Sections = {};
  #done: Step[] = [];
  #undone: Step[] = [];
  #sealed = true; // the next edit starts its own step

  /** What disk holds now; forgets every step, which would overwrite it. */
  reset(meta: Metadata): void {
    this.#saved = structuredClone(meta) as Sections;
    this.#done = [];
    this.#undone = [];
    this.#sealed = true;
  }

  record(sections: Partial<Metadata>, view: string, now = Date.now()): void {
    const after = structuredClone(sections) as Sections;
    const before: Sections = {};
    for (const [k, v] of Object.entries(after)) {
      before[k] = this.#saved[k];
      this.#saved[k] = v ?? undefined;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const last = this.#done.at(-1);
    const keys = (s: Sections) => Object.keys(s).sort().join();
    if (
      last && !this.#sealed && last.view === view &&
      now - last.at < GROUP_MS && keys(last.after) === keys(after)
    ) {
      last.after = after;
      last.at = now;
      return;
    }
    this.#done.push({ before, after, view, at: now });
    this.#undone = [];
    this.#sealed = false;
  }

  canUndo = (): boolean => this.#done.length > 0;
  canRedo = (): boolean => this.#undone.length > 0;

  undo(meta: Metadata): StyleStep | null {
    const step = this.#done.pop();
    if (!step) return null;
    this.#undone.push(step);
    return this.#apply(meta, step.before, step.view);
  }

  redo(meta: Metadata): StyleStep | null {
    const step = this.#undone.pop();
    if (!step) return null;
    this.#done.push(step);
    return this.#apply(meta, step.after, step.view);
  }

  #apply(meta: Metadata, side: Sections, view: string): StyleStep {
    this.#sealed = true;
    const next = { ...meta } as Sections;
    const sections: Sections = {};
    for (const [k, v] of Object.entries(side)) {
      this.#saved[k] = v ?? undefined;
      sections[k] = v == null ? null : structuredClone(v);
      if (v == null) delete next[k];
      else next[k] = structuredClone(v);
    }
    return {
      metadata: next as Metadata,
      sections: sections as Partial<Metadata>,
      view,
    };
  }
}
