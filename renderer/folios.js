// renderer/folios.js — pagination as data: the page map (spec §4.7, §4.8).
// Paged.js only fragments; this reads the finished pages into a page map and
// derives every folio, TOC/ref number and running head from it. Plain JS, a
// classic script like plates.js: it sets `globalThis.BookPageMap`, so Deno
// can import it for unit tests and the browser gets it inlined.

/**
 * @typedef {import("../metadata/types.ts").NumberingStyle} NumberingStyle
 * @typedef {"front" | "body" | "back"} Zone
 * @typedef {{ style: NumberingStyle; show: boolean }} ZoneNumbering
 * @typedef {{ show: boolean; position: string | null }} OpenerNumbering `show: false` drops an opener's folio; `position` moves it to the --folio-opener box
 * @typedef {{ front: ZoneNumbering; body: ZoneNumbering; back: ZoneNumbering; openers?: OpenerNumbering }} PageNumberingConfig
 * @typedef {{ zone: Zone | null; display: boolean; blank: boolean; empty: boolean; opener: boolean; chapterTitles: string[]; partTitles: string[]; anchors: string[] }} PageFacts
 * `opener`: the page holds the start of a chapter or part.
 * `index` is the 0-based position in the map; problems and digests use
 * 1-based physical pages.
 * `folioText` is what the margin box shows ("" when hidden, a display page or
 * a blank); `refText` is the page's number regardless, for TOC rows and
 * `{ref}`. `head`: the page carries a running head — a body page that is not
 * display, blank or an opener (Chicago).
 * @typedef {{ index: number; zone: Zone; display: boolean; blank: boolean; empty: boolean; opener: boolean; head: boolean; folio: number; folioText: string; refText: string; chapterTitle: string; partTitle: string; anchors: string[] }} PageEntry
 * Seed and PageProblem are defined in ./page-map-types.ts; restated here for
 * this file's own checking.
 * @typedef {Record<string, string>} Seed anchor id → refText
 * @typedef {{ page: number | null; message: string; warn?: true }} PageProblem
 * @typedef {{ map: PageEntry[]; seed: Seed; problems: PageProblem[] }} RenderResult
 */

(() => {
  const ROMAN = /** @type {const} */ ([
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ]);

  /** @param {number} n */
  function roman(n) {
    if (n < 1 || n > 3999) return String(n); // CSS lower-roman's range
    let out = "";
    for (const [v, s] of ROMAN) {
      for (; n >= v; n -= v) out += s;
    }
    return out;
  }

  /** a..z, aa..az, ba.. (CSS lower-alpha). @param {number} n */
  function alpha(n) {
    if (n < 1) return String(n);
    let out = "";
    for (; n > 0; n = Math.floor((n - 1) / 26)) {
      out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
    }
    return out;
  }

  /**
   * "words" is arabic for pages (§4.7).
   * @param {number} n
   * @param {NumberingStyle} style
   * @returns {string}
   */
  function formatFolio(n, style) {
    switch (style) {
      case "roman-lower":
        return roman(n);
      case "roman-upper":
        return roman(n).toUpperCase();
      case "alpha-lower":
        return alpha(n);
      case "alpha-upper":
        return alpha(n).toUpperCase();
      case "none":
        return "";
      default:
        return String(n);
    }
  }

  // Running titles carry over through display pages, which show none, so the
  // carried value can't be read back off the previous entry.
  /** @type {WeakMap<PageEntry, { chapter: string; part: string }>} */
  const carried = new WeakMap();

  /**
   * One page's entry from the previous page's. A page with no zone of its own
   * (plate, padding blank) inherits the previous one and still counts. Front
   * starts at 1, body restarts at 1, back continues body's count.
   * @param {PageEntry | null} prev
   * @param {PageFacts} facts
   * @param {PageNumberingConfig} numbering
   * @returns {PageEntry}
   */
  function pageEntry(prev, facts, numbering) {
    const zone = facts.zone ?? prev?.zone ?? "front";
    const folio = !prev || (zone === "body" && prev.zone !== "body")
      ? 1
      : prev.folio + 1;
    const { style, show } = numbering[zone];
    const before = prev
      ? carried.get(prev) ??
        { chapter: prev.chapterTitle, part: prev.partTitle }
      : { chapter: "", part: "" };
    const titles = {
      chapter: facts.chapterTitles[0] ?? before.chapter,
      part: facts.partTitles[0] ?? before.part,
    };
    const head = zone === "body" && !facts.display && !facts.blank &&
      !facts.opener;
    const entry = {
      index: prev ? prev.index + 1 : 0,
      zone,
      display: facts.display,
      blank: facts.blank,
      empty: facts.empty,
      opener: facts.opener,
      head,
      folio,
      folioText: show && !facts.display && !facts.blank &&
          !(facts.opener && numbering.openers?.show === false)
        ? formatFolio(folio, style)
        : "",
      refText: formatFolio(folio, style === "none" ? "arabic" : style),
      chapterTitle: head ? titles.chapter : "",
      partTitle: head ? titles.part : "",
      anchors: facts.anchors,
    };
    carried.set(entry, titles);
    return entry;
  }

  /**
   * @param {PageFacts[]} facts
   * @param {PageNumberingConfig} numbering
   * @returns {PageEntry[]}
   */
  function buildPageMap(facts, numbering) {
    /** @type {PageEntry[]} */
    const map = [];
    for (const f of facts) {
      map.push(pageEntry(map.at(-1) ?? null, f, numbering));
    }
    return map;
  }

  /** @param {PageEntry[]} map @returns {Seed} */
  function anchorFolios(map) {
    /** @type {Seed} */
    const seed = {};
    for (const page of map) {
      for (const id of page.anchors) seed[id] ??= page.refText;
    }
    return seed;
  }

  /** @param {Seed} a @param {Seed} b */
  function sameSeed(a, b) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
  }

  /**
   * @param {PageEntry[]} map
   * @param {string[]} expected anchor ids that must land on a page; the last
   *   is the book's last anchor, so its absence means a truncated render
   * @returns {PageProblem[]}
   */
  function checkPageMap(map, expected) {
    /** @type {PageProblem[]} */
    const problems = [];
    for (const p of map) {
      if (p.empty && !p.blank) {
        problems.push({
          page: p.index + 1,
          message: "stranded page: no text or image",
        });
      }
    }
    const placed = new Set(map.flatMap((p) => p.anchors));
    expected.forEach((id, i) => {
      if (placed.has(id)) return;
      problems.push({
        page: null,
        message: i === expected.length - 1
          ? `"#${id}" is on no page: the render was cut short`
          : `"#${id}" is on no page`,
      });
    });
    return problems;
  }

  /**
   * A short summary for golden tests: each zone's first and last physical
   * page, each anchor's folio, and the blank pages (all 1-based).
   * @param {PageEntry[]} map
   * @returns {{ zones: Record<string, [number, number]>; anchors: Seed; blanks: number[] }}
   */
  function digest(map) {
    /** @type {Record<string, [number, number]>} */
    const zones = {};
    for (const p of map) {
      const z = zones[p.zone];
      if (z) z[1] = p.index + 1;
      else zones[p.zone] = [p.index + 1, p.index + 1];
    }
    return {
      zones,
      anchors: anchorFolios(map),
      blanks: map.filter((p) => p.blank).map((p) => p.index + 1),
    };
  }

  /**
   * Re-render until the folios a render produces are the ones it was seeded
   * with.
   * @param {(seed: Seed) => Promise<RenderResult>} renderOnce
   * @param {Seed} seed
   * @param {number} [maxPasses]
   * @returns {Promise<RenderResult & { passes: number }>}
   */
  async function settle(renderOnce, seed, maxPasses = 3) {
    for (let passes = 1;; passes++) {
      const result = await renderOnce(seed);
      if (sameSeed(result.seed, seed)) return { ...result, passes };
      if (passes >= maxPasses) {
        return {
          ...result,
          problems: [...result.problems, {
            page: null,
            message: `no fixed point after ${maxPasses} passes`,
          }],
          passes,
        };
      }
      seed = result.seed;
    }
  }

  // An image's print resolution at its laid-out size: pixels over CSS inches
  // (96 px each). The computed width is the unzoomed CSS length, so it holds
  // in the preview's zoomed pages. null for a broken image (no pixels) and for
  // vector art, which has no resolution: SVG by its extension (localBackend's
  // object URLs carry the file name as a fragment for this).
  /** @param {HTMLImageElement} img @returns {number | null} */
  function printDpi(img) {
    if (!img.naturalWidth) return null;
    if (/\.svg([?#]|$)|^data:image\/svg/i.test(img.currentSrc || img.src)) {
      return null;
    }
    const width = parseFloat(getComputedStyle(img).width);
    return width > 0 ? Math.round(img.naturalWidth / (width / 96)) : null;
  }

  /** @type {any} */ (globalThis).BookPageMap = {
    formatFolio,
    pageEntry,
    buildPageMap,
    anchorFolios,
    sameSeed,
    checkPageMap,
    digest,
    settle,
    printDpi,
  };

  /** @type {any} */
  const Paged = /** @type {any} */ (globalThis).Paged;
  if (!Paged) return; // Deno unit tests import only the pure core

  /** @type {ZoneNumbering} */
  const ARABIC = { style: "arabic", show: true };
  const PAGE_ENTRY = Symbol("pageEntry");

  /** @param {Element} page @returns {PageFacts} */
  function pageFacts(page) {
    // The content and, with `notes.placement: "footnote"`, the footnote area
    // Paged.js moves `.note`s into: a page holding only a continued footnote
    // isn't stranded.
    const area = page.querySelector(".pagedjs_area") ?? page;
    const zoneEl = area.querySelector(".zone-front, .zone-body, .zone-back");
    const zone = /** @type {Zone | undefined} */ (zoneEl?.className.match(
      /\bzone-(front|body|back)\b/,
    )?.[1]);
    // Continuation fragments repeat their element's title and lose its id.
    /** @param {string} sel */
    const texts = (sel) =>
      [...area.querySelectorAll(`${sel}:not([data-split-from])`)]
        .map((el) => (el.textContent ?? "").trim());
    return {
      zone: zone ?? null,
      display: page.classList.contains("pagedjs_display_page"),
      blank: page.classList.contains("pagedjs_blank_page"),
      empty: !(area.textContent ?? "").trim() && !area.querySelector("img"),
      // The element itself starts here, titled or not: a continued chapter's
      // fragment (and every rebuilt ancestor) carries data-split-from.
      opener: !!area.querySelector(
        ".chapter:not([data-split-from]), .part:not([data-split-from])",
      ),
      chapterTitles: texts(".chapter .title"),
      // `>`: a chapter's title inside a part isn't the part's.
      partTitles: texts(".part > .title"),
      // Paged.js renames a footnote to `note-<data-ref>`; afterParsed kept
      // its own id.
      anchors: [...area.querySelectorAll("[id]:not([data-split-from])")]
        .map((el) => /** @type {HTMLElement} */ (el).dataset.noteId ?? el.id),
    };
  }

  /**
   * @param {Element} page @param {PageEntry} entry
   * @param {PageNumberingConfig} numbering
   */
  function writeEntry(page, entry, numbering) {
    /** @type {any} */ (page)[PAGE_ENTRY] = entry;
    const style = /** @type {HTMLElement} */ (page).style;
    // An opener with its own folio position shows its number in the
    // --folio-opener box (metadata/css-generator.ts) and none in --folio.
    const moved = entry.opener && !!numbering.openers?.position;
    style.setProperty("--folio", JSON.stringify(moved ? "" : entry.folioText));
    style.setProperty(
      "--folio-opener",
      JSON.stringify(moved ? entry.folioText : ""),
    );
    style.setProperty("--chapter-title", JSON.stringify(entry.chapterTitle));
    style.setProperty("--part-title", JSON.stringify(entry.partTitle));
    // Literal and book-title running entries read var(--running-off, "…")
    // (metadata/css-generator.ts); set, it blanks them.
    if (entry.head) style.removeProperty("--running-off");
    else style.setProperty("--running-off", '""');
  }

  // A head or folio that runs to a second line: measured against the same
  // box held to one line, so it holds for any font or line-height, untrimmed
  // (base.css) so each line counts whole. A warning:
  // it's a typographic flaw the preview shows, and never moves the text.
  /**
   * @param {Element} page @param {number} pageNumber
   * @returns {PageProblem[]}
   */
  function wrappedMargins(page, pageNumber) {
    /** @type {PageProblem[]} */
    const problems = [];
    for (const box of page.querySelectorAll(".pagedjs_margin.hasContent")) {
      const content = /** @type {HTMLElement | null} */ (
        box.querySelector(".pagedjs_margin-content")
      );
      if (!content) continue;
      content.dataset.measuring = "";
      const height = content.offsetHeight;
      content.style.whiteSpace = "nowrap";
      const line = content.offsetHeight;
      content.style.whiteSpace = "";
      delete content.dataset.measuring;
      if (line > 0 && height > line * 1.5) {
        const area = [...box.classList].find((c) =>
          c.startsWith("pagedjs_margin-") && c !== "pagedjs_margin-content"
        )?.slice("pagedjs_margin-".length);
        problems.push({
          page: pageNumber,
          warn: true,
          message: `${area} margin box runs to ${
            Math.round(height / line)
          } lines`,
        });
      }
    }
    return problems;
  }

  // An illustration that will print badly: under 200 dpi at its laid-out size,
  // or no image at all (its placeholder, or a file that won't load). Warnings:
  // a proof is worth printing anyway.
  /**
   * @param {Element} page @param {number} pageNumber
   * @returns {PageProblem[]}
   */
  function imageProblems(page, pageNumber) {
    /** @type {PageProblem[]} */
    const problems = [];
    /** @param {string} message */
    const warn = (message) =>
      problems.push({ page: pageNumber, warn: true, message });
    for (
      const el of page.querySelectorAll(
        "figure.illustration img, figure.illustration .illustration-placeholder",
      )
    ) {
      // The figure's id is its slug (plates.js strips the placeholder's
      // data-slug from a plate's copy).
      const slug = el.closest("figure")?.id ?? "";
      if (!(el instanceof HTMLImageElement) || !el.naturalWidth) {
        warn(`an illustration has no image (${slug})`);
        continue;
      }
      const dpi = printDpi(el);
      if (dpi !== null && dpi < 200) {
        warn(`${slug} prints at ${dpi} dpi (300 looks sharp)`);
      }
    }
    return problems;
  }

  Paged.registerHandlers(
    class Folios extends Paged.Handler {
      /** @param {any[]} args */
      constructor(...args) {
        super(...args);
        const settings = this.chunker?.settings?.pageMap ?? {};
        /** @type {Seed} */
        this.seed = settings.seed ?? {};
        /** @type {PageNumberingConfig} */
        this.numbering = settings.numbering ??
          { front: ARABIC, body: ARABIC, back: ARABIC };
        /** @type {string[]} */
        this.expected = [];
        /** @type {PageProblem[]} */
        this.problems = [];
        this.chunker?.on("renderedPage", this.enterAppended.bind(this));
      }

      // Numbers are written before layout, from the seed, so nothing in the
      // flow changes once it's paginated. Runs after Paged.js's own Footnotes
      // handler has marked the notes.
      /** @param {DocumentFragment} parsed */
      afterParsed(parsed) {
        for (const n of parsed.querySelectorAll("[data-note=footnote][id]")) {
          /** @type {HTMLElement} */ (n).dataset.noteId = n.id;
        }
        /** @type {Set<string>} */
        const targets = new Set();
        for (const a of parsed.querySelectorAll(".toc a.page, a.ref")) {
          const id = (a.getAttribute("href") ?? "").replace(/^#/, "");
          a.textContent = this.seed[id] ?? "000";
          targets.add(id);
        }
        const last = [...parsed.querySelectorAll("[id]")].at(-1)?.id;
        if (last) {
          targets.delete(last);
          targets.add(last);
        }
        this.expected = [...targets];
      }

      /** @param {Element} page */
      pageNumber(page) {
        return [...this.chunker.pagesArea.querySelectorAll(".pagedjs_page")]
          .indexOf(page) + 1;
      }

      // Each page's entry is computed once, from the previous page element's
      // stored entry (the object itself: carried titles key on it), and never
      // rewritten. That holds because a laid-out page never changes in 0.4.3:
      // its after-layout reflow (Page.checkOverflowAfterResize, the only path
      // to onOverflow and removePages) passes the start token as
      // findBreakToken's `bounds`, so never finds overflow. A Paged.js that
      // fixes this needs afterRendered to re-read each page's facts and
      // rebuild the map if they changed.
      /** @param {Element} page */
      layOut(page) {
        let prev = page.previousElementSibling;
        while (prev && !prev.classList.contains("pagedjs_page")) {
          prev = prev.previousElementSibling;
        }
        writeEntry(
          page,
          pageEntry(
            /** @type {any} */ (prev)?.[PAGE_ENTRY] ?? null,
            pageFacts(page),
            this.numbering,
          ),
          this.numbering,
        );
      }

      // Paged.js sizes the margin boxes in Margins.finalizePage, right after
      // afterPageLayout and before our finalizePage, measuring their text when
      // a row has a centre box and a side box: --folio and the titles must be
      // on the page by then. Flow pages and padding blanks get them here.
      /** @param {Element} pageElement */
      afterPageLayout(pageElement) {
        this.layOut(pageElement);
      }

      // Runs after Margins.finalizePage for the same page: a page without its
      // entry here had its margins sized from empty variables (a Paged.js that
      // reorders these hooks). Entered anyway so the map stays whole.
      /** @param {Element} pageElement */
      finalizePage(pageElement) {
        if (/** @type {any} */ (pageElement)[PAGE_ENTRY]) return;
        this.problems.push({
          page: this.pageNumber(pageElement),
          message: "margins were sized before the page map reached this page",
        });
        this.layOut(pageElement);
      }

      // Plate pages: plates.js appends them in its own finalizePage, which
      // Paged.js runs alongside ours (the second plate on a page lands after
      // an await), so they're entered once every finalizePage has settled.
      // They're display pages: no margin content to size.
      /** @param {{ element: Element }} page */
      enterAppended({ element }) {
        for (
          let el = element.nextElementSibling;
          el;
          el = el.nextElementSibling
        ) {
          if (
            el.classList.contains("pagedjs_page") &&
            !(/** @type {any} */ (el)[PAGE_ENTRY])
          ) this.layOut(el);
        }
      }

      afterRendered() {
        const pages = this.chunker.pagesArea.querySelectorAll(".pagedjs_page");
        /** @type {PageEntry[]} */
        const map = [];
        [...pages].forEach((page, i) => {
          const entry = /** @type {any} */ (page)[PAGE_ENTRY];
          if (entry) map.push(entry);
          else {
            this.problems.push({ page: i + 1, message: "no page-map entry" });
          }
          this.problems.push(
            ...wrappedMargins(page, i + 1),
            ...imageProblems(page, i + 1),
          );
        });
        /** @type {RenderResult} */
        this.chunker.pageMapResult = {
          map,
          seed: anchorFolios(map),
          problems: [...this.problems, ...checkPageMap(map, this.expected)],
        };
      }
    },
  );
})();
