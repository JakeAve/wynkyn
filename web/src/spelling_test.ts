// web/src/spelling_test.ts
import { assert, assertEquals } from "@std/assert";
import { isKnown, misspelled, parseWordList, suggest } from "./spelling.ts";

const english = parseWordList(
  await Deno.readTextFile(
    new URL("../../vendor/scowl/en.txt", import.meta.url),
  ),
);
const book = new Set(["Gatsby", "shew"]);
const has = (w: string) => english.has(w) || book.has(w);
const words = (line: string) =>
  misspelled(line, has).map(([a, b]) => line.slice(a, b));

Deno.test("spelling: prose words only, markup and comments skipped", () => {
  assert(english.size > 100_000);
  assert(!english.has("Permission")); // the licence header is not a word
  assertEquals(words("{chapter: the-ende | title: Teh Ende}"), []);
  assertEquals(words("%% check: recieve"), []);
  assertEquals(words("He {em}recieved{/em} teh letter\\{wrold}."), [
    "recieved",
    "teh",
    "wrold",
  ]);
  // Case, possessives, curly apostrophes, hyphens, the book's own words.
  assertEquals(
    words("The GATSBY’s mother-in-law don’t shew THE Shew, PARIS’ paris."),
    ["paris"],
  );
});

Deno.test("spelling: a lowercase entry covers capitals, a name needs its own", () => {
  assert(isKnown("Shew", has) && isKnown("SHEW", has));
  assert(!isKnown("gatsby", has));
});

Deno.test("spelling: suggestions one edit away, else two, keeping case", () => {
  assertEquals(suggest("recieved", has)[0], "received");
  assert(suggest("Teh", has).includes("The"));
  assert(suggest("Gatbsy", has).includes("Gatsby"));
  assert(suggest("accomodatoin", has).includes("accommodation"));
});
