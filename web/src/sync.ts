// web/src/sync.ts — the client's save state for one book and edition: the
// manuscript and metadata save queues, their debounce, the versions the
// buffer and the panel are based on, and the hand-off when a save is refused
// because something else changed the manuscript. A failed save keeps its
// payload and retries with backoff; `status()` is the one place the toolbar's
// Saved / Saving / Not saved is decided. No DOM; app.ts adapts it.
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
  retryMs?: (attempt: number) => number; // wait before retry n (from 0)
  current(): string; // the buffer as it is now
  before?(): Promise<unknown>; // awaited before each manuscript save (a rename)
  onConflict(disk: { text: string; version: string }): void;
  onRewrite(text: string): void; // the service rewrote a save: take its text
  onStatus(s: SyncStatus): void; // after any edit, send, landing or failure
}

export type SyncStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; detail: string }
  | { kind: "conflict" };

// 2 s, doubling, at most 30 s.
const backoff = (attempt: number) => Math.min(2000 * 2 ** attempt, 30_000);
const why = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// A refusal (a 4xx: bad name, no such book or edition) fails the same way
// every time; a network error, a 5xx or anything unknown may not. A refused
// save stays `error` until the next edit or flush sends it again.
const retryable = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status < 400 || status >= 500 ||
    status === 408 || status === 429;
};

// One save in flight per channel: a second save while one is pending would
// race the first over the network, and whichever body the service sees last
// wins — an older in-flight save could clobber a newer one on disk. Later
// edits wait behind it (the newest text, or every section merged) and go the
// moment it lands, without a second debounce.
export class Sync {
  #o: SyncOptions;
  #ms: number;
  #retryMs: (attempt: number) => number;
  #base: string | null;
  #metaBase: string | null;
  #dirty = false; // local edits newer than the last completed manuscript save
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingText: string | null = null; // debouncing
  #queuedText: string | null = null; // waiting for the save in flight
  #sending: Promise<void> | null = null;
  #failed: string | null = null; // why the last manuscript save failed
  #tries = 0; // manuscript failures in a row
  #retry: ReturnType<typeof setTimeout> | undefined;
  #conflict = false; // onConflict raised, not yet settled
  #metaTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingMeta: Partial<Metadata> | null = null;
  #queuedMeta: Partial<Metadata> | null = null;
  #metaSending: Promise<void> | null = null;
  #metaFailed: string | null = null;
  #metaTries = 0;
  #metaRetry: ReturnType<typeof setTimeout> | undefined;
  #savedAt: Date | null = null;

  constructor(opts: SyncOptions) {
    this.#o = opts;
    this.#ms = opts.debounceMs ?? 600;
    this.#retryMs = opts.retryMs ?? backoff;
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

  /** Saved only when neither channel has anything debouncing, queued, in
   * flight or failed, and no conflict is waiting on the author. */
  status(): SyncStatus {
    if (this.#conflict) return { kind: "conflict" };
    const failed = this.#failed ??
      (this.#metaFailed === null ? null : `config: ${this.#metaFailed}`);
    if (failed !== null) return { kind: "error", detail: failed };
    return this.hasUnsaved() ? { kind: "saving" } : { kind: "saved" };
  }

  editManuscript(text: string): void {
    this.#dirty = true;
    this.#pendingText = text;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#sendPendingText(), this.#ms);
    this.#changed();
  }

  editMetadata(sections: Partial<Metadata>): void {
    // Saves replace whole sections, so a later edit of one replaces it here.
    this.#pendingMeta = { ...this.#pendingMeta, ...structuredClone(sections) };
    clearTimeout(this.#metaTimer);
    this.#metaTimer = setTimeout(() => this.#sendPendingMeta(), this.#ms);
    this.#changed();
  }

  /** Sends what is debouncing or waiting to retry now; resolves once neither
   * channel has a save in flight or queued (each has landed or failed). */
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
    this.#conflict = false; // settled
    this.#changed();
  }
  rebaseMetadata(version: string | null): void {
    this.#metaBase = version;
  }
  /** Keep mine: base the buffer on the disk version, so the save overwrites it. */
  keepMine(version: string): void {
    this.#base = version;
    this.#conflict = false;
    this.#pendingText = this.#o.current();
    this.#sendPendingText();
  }
  /** The edition is going away: drop the sections waiting to be saved to
   * it (a save in flight still settles). */
  dropMetadata(): void {
    clearTimeout(this.#metaTimer);
    clearTimeout(this.#metaRetry);
    this.#pendingMeta = this.#queuedMeta = null;
    this.#metaFailed = null;
    this.#metaTries = 0;
    this.#changed();
  }
  /** Reload: the disk wins — drop the unsaved edits and anything waiting. */
  dropManuscript(version: string): void {
    clearTimeout(this.#timer);
    clearTimeout(this.#retry);
    this.#pendingText = this.#queuedText = null;
    this.#base = version;
    this.#dirty = false;
    this.#failed = null;
    this.#tries = 0;
    this.#conflict = false;
    this.#changed();
  }

  #changed(): void {
    this.#o.onStatus(this.status());
  }

  #sendPendingText(): void {
    clearTimeout(this.#timer);
    clearTimeout(this.#retry); // a send now is the retry
    const text = this.#pendingText;
    this.#pendingText = null;
    if (text === null) return;
    if (this.#sending) {
      this.#queuedText = text; // only the latest matters
      return;
    }
    this.#sending = this.#saveManuscript(text);
    this.#changed();
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
      this.#failed = null; // it reached the service
      this.#tries = 0;
      if ("conflict" in ok) {
        // Equal: Reload or Keep mine already settled on this version, and a
        // Keep mine save may be queued behind this one — leave it.
        if (ok.version !== this.#base) {
          this.#queuedText = null; // based on the same stale version
          this.#conflict = true;
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
      // Keep the newest text to retry: one debouncing, else one queued
      // behind this save, else this one.
      this.#pendingText ??= this.#queuedText ?? text;
      this.#queuedText = null;
      this.#failed = why(error);
      clearTimeout(this.#retry);
      if (retryable(error)) {
        this.#retry = setTimeout(
          () => this.#sendPendingText(),
          this.#retryMs(this.#tries++),
        );
      }
    } finally {
      this.#sending = null;
      const next = this.#queuedText;
      this.#queuedText = null;
      // Catch-up save, no debounce — the debounce already happened once.
      if (next !== null) this.#sending = this.#saveManuscript(next);
      this.#changed();
    }
  }

  #sendPendingMeta(): void {
    clearTimeout(this.#metaTimer);
    clearTimeout(this.#metaRetry);
    const sections = this.#pendingMeta;
    this.#pendingMeta = null;
    if (sections === null) return;
    if (this.#metaSending) {
      this.#queuedMeta = { ...this.#queuedMeta, ...sections };
      return;
    }
    this.#metaSending = this.#saveMetadata(sections);
    this.#changed();
  }

  async #saveMetadata(sections: Partial<Metadata>): Promise<void> {
    const o = this.#o;
    try {
      await null; // yield, so #metaSending is set before the finally clears it
      this.#metaBase =
        (await o.backend.saveMetadata(o.book, o.edition, sections)).version;
      this.#savedAt = new Date();
      this.#metaFailed = null;
      this.#metaTries = 0;
    } catch (error) {
      // The lost sections go back under any edited since: newer wins per
      // section, and the retry carries them all.
      this.#pendingMeta = {
        ...sections,
        ...this.#queuedMeta,
        ...this.#pendingMeta,
      };
      this.#queuedMeta = null;
      this.#metaFailed = why(error);
      clearTimeout(this.#metaRetry);
      if (retryable(error)) {
        this.#metaRetry = setTimeout(
          () => this.#sendPendingMeta(),
          this.#retryMs(this.#metaTries++),
        );
      }
    } finally {
      this.#metaSending = null;
      const next = this.#queuedMeta;
      this.#queuedMeta = null;
      if (next !== null) {
        this.#metaSending = this.#saveMetadata(next);
      }
      this.#changed();
    }
  }
}
