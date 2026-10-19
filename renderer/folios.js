// renderer/folios.js — pagination as data: the page map (spec §4.7, §4.8).
// Paged.js only fragments; this reads the finished pages into a page map and
// derives every folio, TOC/ref number and running head from it. Plain JS, a
// classic script like plates.js: it sets `globalThis.BookPageMap`, so Deno
// can import it for unit tests and the browser gets it inlined.

/**
 * @typedef {import("../metadata/types.ts").NumberingStyle} NumberingStyle
 * @typedef {"front" | "body" | "back"} Zone
 * @typedef {{ style: NumberingStyle; show: boolean }} ZoneNumbering
 * @typedef {{ front: ZoneNumbering; body: ZoneNumbering; back: ZoneNumbering }} PageNumberingConfig
 * @typedef {{ zone: Zone | null; display: boolean; blank: boolean; empty: boolean; chapterTitles: string[]; partTitles: string[]; anchors: string[] }} PageFacts
 * `index` is the 0-based position in the map; problems and digests use
 * 1-based physical pages.
 * @typedef {{ index: number; zone: Zone; display: boolean; blank: boolean; empty: boolean; folio: number; folioText: string; chapterTitle: string; partTitle: string; anchors: string[] }} PageEntry
 * @typedef {Record<string, string>} Seed anchor id → folio text
 * @typedef {{ page: number | null; message: string }} PageProblem
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
    const running = zone === "body" && !facts.display;
    const entry = {
      index: prev ? prev.index + 1 : 0,
      zone,
      display: facts.display,
      blank: facts.blank,
      empty: facts.empty,
      folio,
      folioText: show && !facts.display ? formatFolio(folio, style) : "",
      chapterTitle: running ? titles.chapter : "",
      partTitle: running ? titles.part : "",
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
      for (const id of page.anchors) seed[id] ??= page.folioText;
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

  /** @type {any} */ (globalThis).BookPageMap = {
    formatFolio,
    pageEntry,
    buildPageMap,
    anchorFolios,
    sameSeed,
    checkPageMap,
    digest,
    settle,
  };
})();
