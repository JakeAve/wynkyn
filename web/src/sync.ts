// web/src/sync.ts — the client's save state for one book and edition: the
// manuscript and metadata save queues, their debounce, the versions the
// buffer and the panel are based on, and the hand-off when a save is refused
// because something else changed the manuscript. No DOM; app.ts adapts it.
import type { Backend } from "./backend.ts";
import type { Metadata } from "../../metadata/types.ts";

export interface SyncOptions {
  backend: Pick<Backend, "saveManuscript" | "saveMetadata">;
  book: string;
  edition: string | null;
  clientId: string;
  base: string | null; // the manuscript version the buffer is based on
  metaBase: string | null; // the metadata version the panel shows
  debounceMs?: number; // both channels; default 600
  current(): string; // the buffer as it is now
  before?(): Promise<unknown>; // awaited before each manuscript save (a rename)
  onConflict(disk: { text: string; version: string }): void;
  onRewrite(text: string): void; // the service rewrote a save: take its text
  onChange(): void; // busy or unsaved state changed, or a save landed or failed
}

export type SyncError = { channel: "manuscript" | "metadata"; error: unknown };

// One save in flight per channel: a second save while one is pending would
// race the first over the network, and whichever body the service sees last
// wins — an older in-flight save could clobber a newer one on disk. Later
// edits wait behind it (the newest text, or every section merged) and go the
// moment it lands, without a second debounce.
export class Sync {
  #o: SyncOptions;
  #ms: number;
  #base: string | null;
  #metaBase: string | null;
  #dirty = false; // local edits newer than the last completed manuscript save
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingText: string | null = null; // debouncing
  #queuedText: string | null = null; // waiting for the save in flight
  #sending: Promise<void> | null = null;
  #metaTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingMeta: Partial<Metadata> | null = null;
  #queuedMeta: Partial<Metadata> | null = null;
  #metaSending: Promise<void> | null = null;
  #savedAt: Date | null = null;
  #error: SyncError | null = null;

  constructor(opts: SyncOptions) {
    this.#o = opts;
    this.#ms = opts.debounceMs ?? 600;
    this.#base = opts.base;
    this.#metaBase = opts.metaBase;
  }

  get base(): string | null {
    return this.#base;
  }
  get metaBase(): string | null {
    return this.#metaBase;
  }
  /** When a manuscript (with the buffer caught up) or metadata save last landed. */
  get savedAt(): Date | null {
    return this.#savedAt;
  }
  /** The last save that failed; a new object per failure. */
  get lastError(): SyncError | null {
    return this.#error;
  }

  editManuscript(text: string): void {
    this.#dirty = true;
    this.#pendingText = text;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#sendPendingText(), this.#ms);
    this.#o.onChange();
  }

  editMetadata(sections: Partial<Metadata>): void {
    // Saves replace whole sections, so a later edit of one replaces it here.
    this.#pendingMeta = { ...this.#pendingMeta, ...structuredClone(sections) };
    clearTimeout(this.#metaTimer);
    this.#metaTimer = setTimeout(() => this.#sendPendingMeta(), this.#ms);
    this.#o.onChange();
  }

  /** Sends what is debouncing now; resolves once neither channel has a save
   * in flight or queued. */
  async flush(): Promise<void> {
    this.#sendPendingText();
    this.#sendPendingMeta();
    while (this.#sending || this.#metaSending) {
      await (this.#sending ?? this.#metaSending);
    }
  }

  hasUnsaved(): boolean {
    return this.#dirty || this.#sending !== null || this.metadataBusy();
  }
  /** Local manuscript edits newer than the last completed save. */
  manuscriptDirty(): boolean {
    return this.#dirty;
  }
  /** A manuscript save is in flight. */
  manuscriptBusy(): boolean {
    return this.#sending !== null;
  }
  /** Sections debouncing, queued or in flight. */
  metadataBusy(): boolean {
    return this.#pendingMeta !== null || this.#queuedMeta !== null ||
      this.#metaSending !== null;
  }

  /** The buffer is based on `version` now (a clean reload, a rename). */
  rebase(version: string): void {
    this.#base = version;
  }
  rebaseMetadata(version: string | null): void {
    this.#metaBase = version;
  }
  /** Keep mine: base the buffer on the disk version, so the save overwrites it. */
  keepMine(version: string): void {
    this.#base = version;
    this.#pendingText = this.#o.current();
    this.#sendPendingText();
  }
  /** Reload: the disk wins — drop the unsaved edits and anything waiting. */
  dropManuscript(version: string): void {
    clearTimeout(this.#timer);
    this.#pendingText = this.#queuedText = null;
    this.#base = version;
    this.#dirty = false;
    this.#o.onChange();
  }

  #sendPendingText(): void {
    clearTimeout(this.#timer);
    const text = this.#pendingText;
    this.#pendingText = null;
    if (text === null) return;
    if (this.#sending) {
      this.#queuedText = text; // only the latest matters
      return;
    }
    this.#sending = this.#saveManuscript(text);
    this.#o.onChange();
  }

  async #saveManuscript(text: string): Promise<void> {
    const o = this.#o;
    try {
      // A rename's token rewrite moves `base`. Always yields, so #sending is
      // set before the finally clears it.
      await o.before?.();
      const ok = await o.backend.saveManuscript(o.book, {
        text,
        clientId: o.clientId,
        base: this.#base,
      });
      if ("conflict" in ok) {
        // Equal: Reload or Keep mine already settled on this version, and a
        // Keep mine save may be queued behind this one — leave it.
        if (ok.version !== this.#base) {
          this.#queuedText = null; // based on the same stale version
          o.onConflict(ok);
        }
        return;
      }
      this.#base = ok.version;
      // The service rewrote the save (a renamed edition's token): take its
      // text, unless the author has typed past what was sent.
      if (ok.text !== undefined && o.current() === text) o.onRewrite(ok.text);
      if (o.current() === (ok.text ?? text)) {
        this.#dirty = false;
        this.#savedAt = new Date();
      }
    } catch (error) {
      this.#error = { channel: "manuscript", error };
    } finally {
      this.#sending = null;
      const next = this.#queuedText;
      this.#queuedText = null;
      // Catch-up save, no debounce — the debounce already happened once.
      if (next !== null) this.#sending = this.#saveManuscript(next);
      o.onChange();
    }
  }

  #sendPendingMeta(): void {
    clearTimeout(this.#metaTimer);
    const sections = this.#pendingMeta;
    this.#pendingMeta = null;
    if (sections === null) return;
    if (this.#metaSending) {
      this.#queuedMeta = { ...this.#queuedMeta, ...sections };
      return;
    }
    this.#metaSending = this.#saveMetadata(sections);
    this.#o.onChange();
  }

  async #saveMetadata(sections: Partial<Metadata>): Promise<void> {
    const o = this.#o;
    try {
      await null; // yield, so #metaSending is set before the finally clears it
      this.#metaBase =
        (await o.backend.saveMetadata(o.book, o.edition, sections)).version;
      this.#savedAt = new Date();
    } catch (error) {
      this.#error = { channel: "metadata", error };
    } finally {
      this.#metaSending = null;
      const next = this.#queuedMeta;
      this.#queuedMeta = null;
      if (next !== null) {
        this.#metaSending = this.#saveMetadata(next);
      }
      o.onChange();
    }
  }
}
