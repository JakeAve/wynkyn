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
 * @typedef {import("./page-map-types.ts").Segment} Segment
 * @typedef {import("./page-map-types.ts").Laid} Laid
 * @typedef {import("./page-map-types.ts").AssemblyPlan} AssemblyPlan
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

  const ONES = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const TENS = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  // ponytail: spelled numbers stop at 99; a book with a hundred chapters gets
  // digits.
  /** @param {number} n */
  function words(n) {
    if (n < 1 || n >= 100) return String(n);
    if (n < 20) return ONES[n] ?? String(n);
    const tens = TENS[Math.floor(n / 10)] ?? "";
    const ones = ONES[n % 10] ?? "";
    return ones ? `${tens}-${ones}` : tens;
  }

  /**
   * The one number formatter: page folios here, and chapter and part numbers
   * through renderer/render.ts.
   * @param {number} n
   * @param {NumberingStyle} style
   * @returns {string}
   */
  function formatNumber(n, style) {
    switch (style) {
      case "roman-lower":
        return roman(n);
      case "roman-upper":
        return roman(n).toUpperCase();
      case "alpha-lower":
        return alpha(n);
      case "alpha-upper":
        return alpha(n).toUpperCase();
      case "words":
        return words(n);
      case "none":
        return "";
      default:
        return String(n);
    }
  }

  /**
   * "words" is arabic for pages (§4.7).
   * @param {number} n
   * @param {NumberingStyle} style
   */
  const formatFolio = (n, style) =>
    formatNumber(n, style === "words" ? "arabic" : style);

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

  /** What `pageFacts` reads off a blank Paged.js adds before a forced side. */
  /** @type {PageFacts} */
  const BLANK = {
    zone: null,
    display: false,
    blank: true,
    empty: true,
    opener: false,
    chapterTitles: [],
    partTitles: [],
    anchors: [],
  };

  /**
   * The book's page order from its segments, laid out alone: each segment's
   * pages in turn, a blank before one that opens on the side it would miss
   * (never before page 1, as Paged.js), then the page map. Problems move from
   * segment pages to book pages; every id a segment renders or reads (a TOC
   * or {ref} target, as the Folios handler's afterParsed expects) must land,
   * the book's last id last.
   * @param {Array<{ opens: "page" | "right" | "left"; facts: PageFacts[]; problems: PageProblem[]; ids: string[]; reads: string[] }>} parts
   * @param {PageNumberingConfig} numbering
   * @returns {AssemblyPlan}
   */
  function planAssembly(parts, numbering) {
    /** @type {Array<{ part: number; page: number } | null>} */
    const slots = [];
    /** @type {PageFacts[]} */
    const facts = [];
    /** @type {PageProblem[]} */
    const problems = [];
    parts.forEach((part, p) => {
      const recto = slots.length % 2 === 0; // the next page, 1-based, is odd
      if (
        slots.length &&
        (part.opens === "right" && !recto || part.opens === "left" && recto)
      ) {
        slots.push(null);
        facts.push(BLANK);
      }
      const first = slots.length;
      part.facts.forEach((f, page) => {
        slots.push({ part: p, page });
        facts.push(f);
      });
      for (const pr of part.problems) {
        problems.push(pr.page === null ? pr : { ...pr, page: pr.page + first });
      }
    });
    const map = buildPageMap(facts, numbering);
    const ids = parts.flatMap((p) => p.ids);
    const expected = new Set([...parts.flatMap((p) => p.reads), ...ids]);
    const last = ids.at(-1);
    if (last !== undefined) {
      expected.delete(last);
      expected.add(last);
    }
    return {
      slots,
      map,
      seed: anchorFolios(map),
      problems: [...problems, ...checkPageMap(map, [...expected])],
    };
  }

  /**
   * `settle` over segments: lay each out, assemble, and re-lay only the
   * segments that print a number the assembly changed (`reads`) until the
   * folios hold. null when the stylesheets of the segments laid in this run
   * differ: their pages can't share one set of sheets, so the caller lays the
   * book out whole. A cached segment (`sheet: null`) takes this run's sheets.
   * @param {Segment[]} segments
   * @param {(s: Segment, seed: Seed) => Promise<Laid>} layOut
   * @param {(laid: Laid[]) => RenderResult} assembleAll
   * @param {Seed} seed
   * @param {number} [maxPasses]
   * @returns {Promise<(RenderResult & { passes: number }) | null>}
   */
  async function settleSegments(
    segments,
    layOut,
    assembleAll,
    seed,
    maxPasses = 3,
  ) {
    /** @type {Laid[]} */
    const laid = [];
    for (const s of segments) laid.push(await layOut(s, seed));
    for (let passes = 1;; passes++) {
      const sheets = laid.flatMap((l) => l.sheet === null ? [] : [l.sheet]);
      if (sheets.some((s) => s !== sheets[0])) return null;
      const result = assembleAll(laid);
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
      const was = seed;
      seed = result.seed;
      let relaid = false;
      for (const [i, s] of segments.entries()) {
        if (s.reads.some((id) => was[id] !== seed[id])) {
          laid[i] = await layOut(s, seed);
          relaid = true;
        }
      }
      // Nothing printed a changed number: assembling again gives these pages.
      if (!relaid) return { ...result, passes };
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
    formatNumber,
    formatFolio,
    pageEntry,
    buildPageMap,
    anchorFolios,
    sameSeed,
    checkPageMap,
    digest,
    settle,
    planAssembly,
    settleSegments,
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
    // The page's own number as the reader sees it ("vii", "12"), shown or not:
    // the write pane's page turns (web/src/preview.ts pageTurns).
    /** @type {HTMLElement} */ (page).dataset.folio = entry.refText;
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

  // A page that changed side (or stopped being first, or is a blank we made)
  // still has the margin boxes Paged.js's Margins.finalizePage set for its old
  // place. Redo them as it does (paged.js:29502): a box has content when some
  // @page rule gives it a `content` other than none, whatever the variable it
  // reads holds, so an empty folio keeps its box; then each row's template
  // from which of its boxes have content. Where Paged.js writes none (no box
  // at all: its template string comes out invalid) the stylesheet's stands,
  // and a centre beside a side box is base.css's (!important).
  // ponytail: assumes margin boxes with no width or height, as css-generator
  // writes them, and gives a row with both side boxes and no centre 1fr 0 1fr
  // where Paged.js measures the two; port that if a book needs it.
  /** @param {Element} page */
  function redoMargins(page) {
    for (const box of page.querySelectorAll(".pagedjs_margin")) {
      const inner = box.querySelector(".pagedjs_margin-content");
      const content = inner
        ? getComputedStyle(inner, "::after").content
        : "none";
      box.classList.toggle(
        "hasContent",
        content !== "none" && content !== "normal",
      );
    }
    for (
      const [group, prop, boxes] of /** @type {const} */ ([
        ["top", "grid-template-columns", ["left", "center", "right"]],
        ["bottom", "grid-template-columns", ["left", "center", "right"]],
        ["left", "grid-template-rows", ["top", "middle", "bottom"]],
        ["right", "grid-template-rows", ["top", "middle", "bottom"]],
      ])
    ) {
      const [a, mid, b] = boxes.map((box) =>
        !!page.querySelector(`.pagedjs_margin-${group}-${box}.hasContent`)
      );
      const template = mid
        ? (a || b ? "" : "0 1fr 0")
        : a
        ? (b ? "1fr 0 1fr" : "1fr 0 0")
        : b
        ? "0 0 1fr"
        : "";
      const style = /** @type {HTMLElement | null} */ (
        page.querySelector(`.pagedjs_margin-${group}`)
      )?.style;
      if (template) style?.setProperty(prop, template);
      else style?.removeProperty(prop);
    }
  }

  /**
   * A blank like Paged.js's `addPage(true)` (paged.js:3153): the page
   * template with `pagedjs_blank_page` and no named page, its content area
   * given the column width every page's has.
   * @param {HTMLTemplateElement} pageTemplate @param {Element | undefined} like
   */
  function blankPage(pageTemplate, like) {
    const page = /** @type {HTMLElement} */ (
      document.importNode(pageTemplate.content, true).firstElementChild
    );
    page.classList.add("pagedjs_blank_page");
    const area = /** @type {HTMLElement | null} */ (
      page.querySelector(".pagedjs_page_content")
    );
    const from = /** @type {HTMLElement | null | undefined} */ (
      like?.querySelector(".pagedjs_page_content")
    );
    if (area && from) {
      area.style.columnWidth = from.style.columnWidth;
      area.style.columnGap = from.style.columnGap;
    }
    return page;
  }

  /**
   * Lay the segments' pages into `pagesArea` as one book (spec: segmented
   * layout, Assembly): blanks where a side is forced, each page renumbered
   * and given its side, its page-map entry written, the margin boxes of moved
   * pages redone, then the checks a whole-flow render runs after layout.
   * @param {Laid[]} laid
   * @param {PageNumberingConfig} numbering
   * @param {Element} pagesArea in the document: margins are read off styles
   * @param {HTMLTemplateElement} pageTemplate
   * @returns {RenderResult}
   */
  function assemble(laid, numbering, pagesArea, pageTemplate) {
    const plan = planAssembly(
      laid.map((l) => ({
        opens: l.segment.opens,
        facts: l.facts,
        problems: l.problems,
        ids: l.segment.ids,
        reads: l.segment.reads,
      })),
      numbering,
    );
    // Paged.js marks a forced break on the element it falls before and on
    // its page (paged.js:30055, :30102); a segment's first section, laid out
    // alone, has nothing before it, so it is marked here as one flow would be.
    laid.forEach((l, i) => {
      const page = l.pages[0];
      const first = page?.querySelector("section:not([data-split-from])");
      if (i === 0 || !page || !first) return;
      first.setAttribute("data-break-before", l.segment.opens);
      page.setAttribute("data-break-before", l.segment.opens);
    });
    const like = laid.find((l) => l.pages.length)?.pages[0];
    const pages = plan.slots.map((s) =>
      s
        ? /** @type {Element} */ (laid[s.part]?.pages[s.page])
        : blankPage(pageTemplate, like)
    );
    pagesArea.replaceChildren(...pages);
    /** @type {PageProblem[]} */
    const problems = [...plan.problems];
    pages.forEach((page, i) => {
      const was = page.className;
      page.classList.toggle("pagedjs_first_page", i === 0);
      page.classList.toggle("pagedjs_right_page", i % 2 === 0);
      page.classList.toggle("pagedjs_left_page", i % 2 === 1);
      page.id = `page-${i + 1}`;
      /** @type {HTMLElement} */ (page).dataset.pageNumber = String(i + 1);
      writeEntry(page, /** @type {PageEntry} */ (plan.map[i]), numbering);
      if (!plan.slots[i] || page.className !== was) redoMargins(page);
      problems.push(
        ...wrappedMargins(page, i + 1),
        ...imageProblems(page, i + 1),
      );
    });
    return { map: plan.map, seed: plan.seed, problems };
  }

  /** @type {any} */ (globalThis).BookPageMap.assemble = assemble;

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
        // A segment laid out alone: the after-layout checks wait for
        // assembly, where its pages have their book sides and neighbours.
        /** @type {boolean} */
        this.segment = settings.segment ?? false;
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
          if (this.segment) return;
          this.problems.push(
            ...wrappedMargins(page, i + 1),
            ...imageProblems(page, i + 1),
          );
        });
        /** @type {RenderResult & { facts: PageFacts[] }} */
        this.chunker.pageMapResult = {
          map,
          seed: anchorFolios(map),
          problems: this.segment
            ? this.problems
            : [...this.problems, ...checkPageMap(map, this.expected)],
          facts: [...pages].map(pageFacts),
        };
      }
    },
  );
})();
