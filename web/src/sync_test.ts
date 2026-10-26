import { assert, assertEquals } from "@std/assert";
import { Sync, type SyncOptions } from "./sync.ts";
import type { SaveResult } from "../../server/book-service.ts";
import type { Metadata } from "../../metadata/types.ts";

// A backend whose saves wait until the test settles them, one by one.
function fakeBackend() {
  const texts: Array<{ text: string; base: string | null }> = [];
  const sections: object[] = [];
  const ms: Array<(r: SaveResult | Error) => void> = [];
  const meta: Array<(r: { version: string } | Error) => void> = [];
  const settle =
    <T>(r: T | Error) => (ok: (v: T) => void, no: (e: Error) => void) =>
      r instanceof Error ? no(r) : ok(r);
  return {
    texts,
    sections,
    backend: {
      saveManuscript: (
        _book: string,
        s: { text: string; base: string | null },
      ) => {
        texts.push({ text: s.text, base: s.base });
        return new Promise<SaveResult>((ok, no) =>
          ms.push((r) => settle(r)(ok, no))
        );
      },
      saveMetadata: (_b: string, _e: string | null, s: object) => {
        sections.push(s);
        return new Promise<{ version: string }>((ok, no) =>
          meta.push((r) => settle(r)(ok, no))
        );
      },
    },
    // Lands the oldest open save and lets the sync react.
    async landText(r: SaveResult | Error): Promise<void> {
      ms.shift()!(r);
      await tick();
    },
    async landMeta(r: { version: string } | Error): Promise<void> {
      meta.shift()!(r);
      await tick();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(over: Partial<SyncOptions> = {}) {
  const fake = fakeBackend();
  let buffer = "";
  const log: string[] = [];
  const sync = new Sync({
    backend: fake.backend,
    book: "b",
    edition: null,
    clientId: "c",
    base: "v0",
    metaBase: null,
    debounceMs: 5,
    current: () => buffer,
    onConflict: (d) => log.push(`conflict ${d.version}`),
    onRewrite: (t) => {
      log.push(`rewrite ${t}`);
      buffer = t;
    },
    onChange: () => {},
    ...over,
  });
  const type = (t: string) => {
    buffer = t;
    sync.editManuscript(t);
  };
  return { fake, sync, type, log };
}

Deno.test("sync: one manuscript save in flight; later edits coalesce to the newest", async () => {
  const { fake, sync, type } = setup();
  type("a");
  await wait(10);
  assertEquals(fake.texts, [{ text: "a", base: "v0" }]);
  assert(sync.manuscriptBusy());
  type("ab");
  await wait(10);
  type("abc");
  await wait(10);
  assertEquals(fake.texts.length, 1); // waits for the first
  await fake.landText({ ok: true, version: "v1" });
  assertEquals(fake.texts[1], { text: "abc", base: "v1" }); // newest, no debounce
  assert(sync.manuscriptDirty());
  await fake.landText({ ok: true, version: "v2" });
  assertEquals(sync.base, "v2");
  assert(!sync.hasUnsaved());
  assert(sync.savedAt);
});

Deno.test("sync: metadata sections merge behind the save in flight", async () => {
  const { fake, sync } = setup();
  sync.editMetadata({ fonts: { body: "A" } });
  await wait(10);
  sync.editMetadata({ fonts: { body: "B" } });
  sync.editMetadata({ language: "es" } as Partial<Metadata>);
  await wait(10);
  assertEquals(fake.sections.length, 1);
  assert(sync.metadataBusy());
  await fake.landMeta({ version: "m1" });
  assertEquals(fake.sections[1], { fonts: { body: "B" }, language: "es" });
  await fake.landMeta({ version: "m2" });
  assertEquals(sync.metaBase, "m2");
  assert(!sync.metadataBusy());
});

Deno.test("sync: a conflict with a new version drops the queued text and hands off", async () => {
  const { fake, sync, type, log } = setup();
  type("a");
  await wait(10);
  type("ab");
  await wait(10); // queued behind "a"
  await fake.landText({ conflict: true, text: "disk", version: "v9" });
  assertEquals(log, ["conflict v9"]);
  assertEquals(fake.texts.length, 1); // "ab" was based on the same stale version
  assert(sync.manuscriptDirty() && !sync.manuscriptBusy());
  sync.keepMine("v9");
  await tick();
  assertEquals(fake.texts[1], { text: "ab", base: "v9" });
});

Deno.test("sync: a conflict at the current version is already settled", async () => {
  const { fake, type, log } = setup();
  type("a");
  await wait(10);
  await fake.landText({ conflict: true, text: "disk", version: "v0" });
  assertEquals(log, []);
});

Deno.test("sync: a rewrite replaces the buffer only if untyped past what was sent", async () => {
  const { fake, sync, type, log } = setup();
  type("old");
  await wait(10);
  await fake.landText({ ok: true, version: "v1", text: "new" });
  assertEquals(log, ["rewrite new"]);
  assert(!sync.manuscriptDirty());
  type("x");
  await wait(10);
  type("xy"); // typed past the save in flight
  await fake.landText({ ok: true, version: "v2", text: "X" });
  assertEquals(log, ["rewrite new"]);
  assert(sync.manuscriptDirty());
});

Deno.test("sync: flush sends now and resolves after both channels land", async () => {
  const { fake, sync, type } = setup({ debounceMs: 10_000 });
  type("a");
  sync.editMetadata({ fonts: {} });
  let done = false;
  const flushed = sync.flush().then(() => done = true);
  await tick();
  assertEquals(fake.texts.length, 1);
  assertEquals(fake.sections.length, 1);
  await fake.landText({ ok: true, version: "v1" });
  assert(!done);
  await fake.landMeta(new Error("down"));
  await flushed;
  assertEquals(sync.lastError?.channel, "metadata");
});

Deno.test("sync: debounceMs is honoured, and before() runs first", async () => {
  let release = () => {};
  const renaming = new Promise<void>((r) => release = r);
  const { fake, type } = setup({ debounceMs: 40, before: () => renaming });
  type("a");
  await wait(20);
  type("ab");
  await wait(20);
  assertEquals(fake.texts.length, 0); // the second edit restarted the wait
  await wait(30);
  assertEquals(fake.texts.length, 0); // waiting on the rename
  release();
  await tick();
  assertEquals(fake.texts, [{ text: "ab", base: "v0" }]);
});

Deno.test("sync: dropManuscript forgets the waiting text and rebases", async () => {
  const { fake, sync, type } = setup();
  type("a");
  sync.dropManuscript("v5");
  await wait(10);
  assertEquals(fake.texts.length, 0);
  assertEquals(sync.base, "v5");
  assert(!sync.hasUnsaved());
});
