import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertRejects,
} from "@std/assert";
import { BookService, ServiceError } from "./book-service.ts";
import type { BookStore } from "./store.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { quietFor, until } from "../testing/wait.ts";
import { contentVersion, type ServerMessage } from "./pipeline.ts";

const book = "demo-book";

async function demoStore(): Promise<BookStore> {
  const src = new URL("./testdata/demo-book/", import.meta.url);
  const files = new Map<string, Uint8Array>();
  for (const f of ["manuscript.md", "metadata.json", "editions/pocket.json"]) {
    files.set(`${book}/${f}`, await Deno.readFile(new URL(f, src)));
  }
  return memoryStore(files);
}

Deno.test("history: a save then idle takes one version", async () => {
  const service = new BookService({
    store: await demoStore(),
    historyIdleMs: 10,
    historyMaxMs: 60_000,
  });
  try {
    const text = "{matter: half-title}\n{title}\nFirst\n";
    await service.saveManuscript(book, { text });
    await until(async () => (await service.history(book)).length > 0);
    const [v, ...rest] = await service.history(book);
    assertEquals([v?.reason, rest.length], ["idle", 0]);
    const { files } = await service.versionFiles(book, v!.id);
    assertEquals(files["manuscript.md"], text);
  } finally {
    await service.stop();
  }
});

Deno.test("history: first subscribe snapshots; restore snapshots first and reaches clients once", async () => {
  const store = await demoStore();
  const service = new BookService({ store });
  try {
    const heard: Extract<ServerMessage, { type: "update" }>[] = [];
    service.subscribe(book, null, "c", (m) => {
      if (m.type === "update") heard.push(m);
    });
    await until(async () => (await service.history(book)).length > 0);
    const [open] = await service.history(book);
    assertEquals(open?.reason, "open");
    const original = await store.readText(`${book}/manuscript.md`);

    await service.saveManuscript(book, { text: "{title}\nSecond\n" });
    const seen = heard.length;
    const before = await service.restoreVersion(book, open!.id, "text");
    assertEquals(before?.reason, "before-restore");
    assertEquals(await store.readText(`${book}/manuscript.md`), original);
    const { files } = await service.versionFiles(book, before!.id);
    assertEquals(files["manuscript.md"], "{title}\nSecond\n");

    const v = await contentVersion(original!);
    const restored = () =>
      heard.slice(seen).filter((m) => m.manuscriptVersion === v);
    await until(() => restored().length > 0, "the restore's update");
    await quietFor(50); // a second push would be in by now
    assertEquals(restored().length, 1);
  } finally {
    await service.stop();
  }
});

Deno.test("history: a metadata save in flight lands in the before-restore snapshot, one made during the restore lands after it", async () => {
  const base = await demoStore();
  let release!: () => void, releaseRestore!: () => void;
  const gates = [
    new Promise<void>((r) => release = r),
    new Promise<void>((r) => releaseRestore = r),
  ];
  let writes = 0;
  const store: BookStore = {
    ...base,
    async write(path, data) {
      if (path === `${book}/metadata.json`) await gates[writes++];
      return base.write(path, data);
    },
  };
  const service = new BookService({ store });
  try {
    const start = await service.nameVersion(book, null, "start");
    const original = await store.readText(`${book}/metadata.json`);
    const saved = service.saveMetadata(book, null, { name: "Changed" });
    let done = false;
    const restoring = service.restoreVersion(book, start.id, { edition: null })
      .finally(() => done = true);
    await quietFor(50);
    assertEquals(done, false, "the restore waits for the save under way");
    release();
    await saved;
    await until(() => writes === 2, "the restore's write");
    const late = service.saveMetadata(book, null, { name: "Late" });
    await quietFor(50);
    assertEquals(writes, 2, "the late save waits for the restore");
    releaseRestore();
    const before = await restoring;
    await late;
    assertObjectMatch(
      JSON.parse((await store.readText(`${book}/metadata.json`))!),
      { ...JSON.parse(original!), name: "Late" },
    );
    const { files } = await service.versionFiles(book, before!.id);
    assert(files["metadata.json"]?.includes("Changed"));
  } finally {
    release();
    releaseRestore();
    await service.stop();
  }
});

Deno.test("history: bad input is a 400 before any snapshot", async () => {
  const service = new BookService({ store: await demoStore() });
  try {
    const v = await service.nameVersion(book, null, "start");
    await service.saveManuscript(book, { text: "{title}\nChanged\n" });
    const calls: [string, () => Promise<unknown>][] = [
      ...[
        "every",
        null,
        {},
        { edition: "../x" },
        { edition: 3 },
        { edition: null, extra: 1 },
        ["all"],
      ].map((scope): [string, () => Promise<unknown>] => [
        JSON.stringify(scope),
        () => service.restoreVersion(book, v.id, scope as never),
      ]),
      ["bad id", () => service.restoreVersion(book, "../x", "all")],
      ["bad id", () => service.versionFiles(book, "../x")],
    ];
    for (const [what, call] of calls) {
      const e = await assertRejects(call, ServiceError);
      assertEquals(e.status, 400, what);
    }
    assertEquals((await service.history(book)).length, 1);
    const nf = await assertRejects(
      () => service.restoreVersion(book, "2001-01-01T00-00-00.000Z", "all"),
      ServiceError,
    );
    assertEquals(nf.status, 404);
  } finally {
    await service.stop();
  }
});
