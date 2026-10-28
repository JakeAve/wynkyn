// web/src/theme-preview.ts — Theme preview and Apply (spec §7.5).
// A previewed theme's build is on screen and nothing is saved. Pushed builds
// are held meanwhile; ending the preview shows the newest one. Apply always
// asks: a new edition, or replace this edition's style. app.ts paints.
import type { Backend } from "./backend.ts";
import type { ConfigPanel } from "./config-panel.ts";
import type { Metadata } from "../../metadata/types.ts";
import type { UpdateMessage } from "./preview.ts";
import type { Sync } from "./sync.ts";
import {
  cacheId,
  type LegacyRender as CachedRender,
  loadLegacyRender as loadCachedRender,
  renderHash,
} from "./preview-cache.ts";
import { editionHref, freeSlug } from "./editions.ts";
import { applyTheme, THEMES } from "../../metadata/themes.ts";
import { $, brief } from "./dom.ts";

export interface ThemePreviewDeps {
  backend(): Backend;
  book(): string;
  edition(): string | null;
  sync(): Sync;
  configPanel(): ConfigPanel | null;
  // The edition's metadata with every style edit landed.
  settledMetadata(): Promise<Metadata>;
  setMetadata(m: Metadata): void; // what the panel shows, before the save
  saveSections(sections: Partial<Metadata>): void;
  // A null cacheKey paints without touching the book's cached render.
  paint(msg: UpdateMessage, cacheKey?: string | null): void;
  // `version`: the manuscript version the cached pages were built from.
  restore(cached: CachedRender, version?: string): void;
  leave(href: string): Promise<void>;
  setStatus(kind: "error", detail: string): void;
}

const themeName = (slug: string) =>
  THEMES.find((t) => t.slug === slug)?.name ?? slug;

// What a theme owns (spec §4.13), as the sections a save replaces.
const themeSections = (m: Metadata): Partial<Metadata> => ({
  fonts: m.fonts,
  elements: m.elements,
  numbering: m.numbering,
  running: m.running,
});

export class ThemePreview {
  #d: ThemePreviewDeps;
  #slug: string | null = null; // the theme on screen, or null
  #gen = 0; // bumped by every try and by the end, so a stale build drops
  #from: string | null = null; // the manuscript version it was built from
  #shown: UpdateMessage | null = null; // the theme's build on screen
  #held: UpdateMessage | null = null; // newest push held while previewing
  lastShown: UpdateMessage | null = null; // the last real build painted
  #applying: string | null = null; // the theme the dialog is asking about

  constructor(deps: ThemePreviewDeps) {
    this.#d = deps;
  }

  async try(slug: string | null): Promise<void> {
    if (slug === null) return this.end();
    const d = this.#d;
    const gen = ++this.#gen;
    this.#slug = slug;
    $("preview").dataset.stale = "";
    d.configPanel()?.themeTried(slug);
    try {
      const meta = applyTheme(await d.settledMetadata(), slug);
      const built = await d.backend().tryBuild(d.book(), d.edition(), meta);
      if (gen !== this.#gen) return; // another card, or Discard, since
      this.#from = built.manuscriptVersion;
      this.#shown = { ...built, type: "update" };
      // Not cached: a reload must not open on a look never applied.
      d.paint(this.#shown, null);
    } catch (err) {
      if (gen !== this.#gen) return;
      this.end(); // a held push must not stay held behind a bar for good
      d.setStatus("error", `preview: ${brief(err)}`);
    }
  }

  // Back to the book's own look: the newest held push, else the last build.
  // `applied`: the previewed look is now the book's, so keep it on screen.
  end(applied = false): void {
    if (this.#slug === null) return;
    this.#slug = null;
    const gen = ++this.#gen;
    this.#d.configPanel()?.themeTried(null);
    if (applied && this.#shown) this.lastShown = this.#shown;
    const next = this.#held ?? this.lastShown;
    this.#held = this.#shown = null;
    if (!applied) void this.#showBookPages(next, gen);
  }

  // The book's cached render when it is what should show (no Paged.js pass),
  // else a fresh render of `next`. With neither, the pages clear: the book's
  // first build paints when it lands.
  async #showBookPages(
    next: UpdateMessage | null,
    gen: number,
  ): Promise<void> {
    const d = this.#d;
    const cached = await loadCachedRender(cacheId(d.book(), d.edition()));
    if (gen !== this.#gen) return; // a new preview since
    if (next && cached?.hash !== renderHash(next)) {
      this.lastShown = next;
      return d.paint(next);
    }
    d.restore(
      cached ??
        {
          hash: "",
          pages: "",
          styles: [],
          fontLinks: "",
          seed: {},
          problems: [],
        },
      // the cache holds `next`'s pages (same hash); without it, unknown
      cached && next ? next.manuscriptVersion : undefined,
    );
  }

  // A push while previewing: held, and a manuscript change rebuilds the theme.
  hold(msg: UpdateMessage): boolean {
    if (this.#slug === null) return false;
    this.#held = msg;
    if (msg.manuscriptVersion !== this.#from) void this.try(this.#slug);
    return true;
  }

  // Apply always asks (spec §7.5): a new edition (the safe choice), or replace
  // this edition's style. Cancel keeps the preview.
  askApply(slug: string): void {
    const dlg = $("theme-dlg") as HTMLDialogElement;
    this.#applying = slug;
    for (const el of dlg.querySelectorAll(".t-name")) {
      el.textContent = themeName(slug);
    }
    for (const el of dlg.querySelectorAll(".e-name")) {
      el.textContent = $("edition-name").textContent;
    }
    $("theme-err").textContent = "";
    if (!dlg.open) dlg.showModal();
  }

  installApply(): void {
    const d = this.#d;
    const dlg = $("theme-dlg") as HTMLDialogElement;
    const buttons = [...dlg.querySelectorAll("button")];
    $("theme-cancel").onclick = () => dlg.close();
    const run = (act: (slug: string) => Promise<void>) => async () => {
      if (!this.#applying) return;
      for (const b of buttons) b.disabled = true;
      try {
        await act(this.#applying);
      } catch (err) {
        $("theme-err").textContent = brief(err);
      } finally {
        for (const b of buttons) b.disabled = false;
      }
    };
    $("theme-new").onclick = run(async (slug) => {
      const backend = d.backend(), book = d.book();
      const applied = applyTheme(await d.settledMetadata(), slug);
      const taken = (await backend.editions(book)).flatMap((e) =>
        e.slug === null ? [] : [e.slug]
      );
      const next = freeSlug(slug, taken);
      await backend.createEdition(book, next, d.edition() ?? "default");
      try {
        await backend.saveMetadata(book, next, themeSections(applied));
      } catch (err) {
        // An edition named for the theme but holding the old style misleads.
        await backend.deleteEdition(book, next).catch(() => {});
        throw err;
      }
      await d.leave(editionHref(book, next));
    });
    $("theme-replace").onclick = run(async (slug) => {
      const applied = applyTheme(await d.settledMetadata(), slug);
      d.setMetadata(applied);
      d.saveSections(themeSections(applied));
      void d.sync().flush(); // no debounce: the author chose this
      d.configPanel()?.refresh(applied);
      this.end(true);
      dlg.close();
    });
  }
}
