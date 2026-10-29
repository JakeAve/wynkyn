import { assertEquals, assertNotEquals } from "@std/assert";
import type { Segment } from "../../renderer/page-map-types.ts";
import {
  reacher,
  segmentKey,
  segmentStyleHash,
  shiftLines,
  styleHash,
  tokenImages,
  untokenImages,
} from "./preview-cache.ts";

const style = { baseCss: "a{}", domCss: "b{}", pagedCss: "c{}", fontLinks: "" };
const S = styleHash(style);
const urls = { "a b&c.png": "/books/x/images/a%20b&c.png" };

function seg(line: number, text = "One", src = urls["a b&c.png"]): Segment {
  return {
    id: "one",
    html:
      `<article class="bml"><section class="chapter" data-line="${line}"><p data-line="${
        line + 2
      }">${text}</p><img src="${src.replaceAll("&", "&amp;")}"></section>` +
      `<nav class="toc"><a href="#two">Two</a></nav></article>`,
    line,
    opens: "page",
    reads: ["two"],
    ids: ["one"],
  };
}

Deno.test("styleHash: a change in any field changes it", () => {
  for (const k of Object.keys(style) as (keyof typeof style)[]) {
    assertNotEquals(styleHash({ ...style, [k]: style[k] + "x" }), S);
  }
});

Deno.test("reacher: a selector reaches html holding its every tag and class", () => {
  const title = reacher(
    `<article class="bml"><section class="matter matter-title-page"><h1 class="title">T</h1></section></article>`,
  );
  const chapter = reacher(seg(1).html);
  assertEquals(title(".matter-title-page .title"), true);
  assertEquals(chapter(".matter-title-page .title"), false);
  assertEquals(chapter(".chapter > .number"), false);
  assertEquals(chapter(".bml p"), true);
  assertEquals(chapter(".bml em"), false);
  assertEquals(chapter(".matter-preface, .chapter"), true);
  // A shape it can't read reaches everything.
  assertEquals(chapter(".chapter :is(.x)"), true);
});

Deno.test("segmentStyleHash: changes with the rules that reach the segment only", () => {
  const u = {
    baseCss: "a{}",
    pagedCss: "c{}",
    domRules: [
      { selector: ".chapter", css: ".chapter{}" },
      { selector: ".matter-title-page .title", css: "t{}" },
    ],
  };
  const h = segmentStyleHash(seg(1), u);
  const rules = (title: string, chapter = ".chapter{}") => ({
    ...u,
    domRules: [
      { selector: ".chapter", css: chapter },
      { selector: ".matter-title-page .title", css: title },
    ],
  });
  assertEquals(segmentStyleHash(seg(1), rules("t{x}")), h);
  assertNotEquals(segmentStyleHash(seg(1), rules("t{}", ".chapter{x}")), h);
  assertNotEquals(segmentStyleHash(seg(1), { ...u, pagedCss: "" }), h);
  assertNotEquals(segmentStyleHash(seg(1), { ...u, baseCss: "" }), h);
});

Deno.test("segmentKey: changes with its own text or a read seed value", () => {
  const key = segmentKey(seg(10), S, { two: "5" }, urls);
  assertEquals(segmentKey(seg(10), S, { two: "5" }, urls), key);
  assertNotEquals(segmentKey(seg(10, "Uno"), S, { two: "5" }, urls), key);
  assertNotEquals(segmentKey(seg(10), S, { two: "6" }, urls), key);
  assertNotEquals(segmentKey(seg(10), S, {}, urls), key);
  assertNotEquals(
    segmentKey(seg(10), styleHash({ ...style, domCss: "" }), {
      two: "5",
    }, urls),
    key,
  );
  // A seed value the segment doesn't read leaves it alone.
  assertEquals(segmentKey(seg(10), S, { two: "5", three: "9" }, urls), key);
});

Deno.test("segmentKey: a line shift or a new blob: URL keeps it", () => {
  const key = segmentKey(seg(10), S, { two: "5" }, urls);
  assertEquals(segmentKey(seg(40), S, { two: "5" }, urls), key);
  const a = { "a b&c.png": "blob:http://x/1111" };
  const b = { "a b&c.png": "blob:http://x/2222" };
  assertEquals(
    segmentKey(seg(10, "One", a["a b&c.png"]), S, { two: "5" }, a),
    segmentKey(seg(10, "One", b["a b&c.png"]), S, { two: "5" }, b),
  );
});

Deno.test("shiftLines: rewrites every data-line and round-trips", () => {
  const html = seg(10).html;
  const rel = shiftLines(html, -10);
  assertEquals(rel.match(/data-line="\d+"/g), [
    'data-line="0"',
    'data-line="2"',
  ]);
  assertEquals(shiftLines(rel, 10), html);
});

Deno.test("tokenImages/untokenImages: URLs become names and back", () => {
  const html = seg(1).html;
  const tokened = tokenImages(html, urls);
  assertEquals(tokened.includes('src="wynkyn-image:a%20b%26c.png"'), true);
  assertEquals(tokened.includes("/books/"), false);
  assertEquals(untokenImages(tokened, (n) => urls[n as "a b&c.png"]), html);
  assertEquals(
    untokenImages(tokened, (n) => `blob:x/${n}`),
    html.replace(/src="[^"]*"/, 'src="blob:x/a b&amp;c.png"'),
  );
});
