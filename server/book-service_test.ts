// server/book-service_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { BookService, ServiceError } from "./book-service.ts";
import { diskStore, withTabs } from "./store.ts";
import { memoryStore } from "../testing/memory-store.ts";
import { quietFor, until } from "../testing/wait.ts";
import { contentVersion, imageFiles, type ServerMessage } from "./pipeline.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

// A library with one book, demo-book, and its pocket edition.
async function library(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/demo-book/editions`, { recursive: true });
  await Deno.writeTextFile(`${root}/demo-book/manuscript.md`, "{title}\nX\n");
  await Deno.writeTextFile(`${root}/demo-book/metadata.json`, "{}\n");
  await Deno.writeTextFile(`${root}/demo-book/editions/pocket.json`, "{}\n");
  return root;
}
const readJson = async (path: string) =>
  JSON.parse(await Deno.readTextFile(path));

Deno.test("metadata: a save resolves after the file is written", async () => {
  const root = await library();
  const path = `${root}/demo-book/metadata.json`;
  const service = new BookService({ store: diskStore(root) });
  try {
    const { version } = await service.saveMetadata("demo-book", null, {
      notes: { placement: "footnote" },
    });
    assertEquals(version, await contentVersion(await Deno.readTextFile(path)));
    assertEquals((await readJson(path)).notes, { placement: "footnote" });

    // A failed write rejects, and the file is as it was.
    const before = await Deno.readTextFile(path);
    const failing = new BookService({
      store: {
        ...diskStore(root),
        write: () => Promise.reject(new Error("disk full")),
      },
    });
    const err = await assertRejects(
      () => failing.saveMetadata("demo-book", null, { toc: {} }),
      ServiceError,
    );
    assertEquals(err.status, 500);
    assertEquals(await Deno.readTextFile(path), before);
    await failing.stop();
  } finally {
    await service.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("editions: rename right after a style edit keeps the edit", async () => {
  const root = await library();
  const service = new BookService({ store: diskStore(root) });
  try {
    // Not awaited: the rename is asked for while the save is under way.
    const saved = service.saveMetadata("demo-book", "pocket", {
      page: { size: "A6" },
    });
    await service.renameEdition("demo-book", "pocket", "travel");
    await saved;
    assertEquals(
      (await readJson(`${root}/demo-book/editions/travel.json`)).page,
      { size: "A6" },
    );
    assertEquals(
      await service.metadata("demo-book", "travel").then((m) =>
        m.metadata.page
      ),
      { size: "A6" },
    );
  } finally {
    await service.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stop: nothing pending is lost", async () => {
  const root = await library();
  const service = new BookService({ store: diskStore(root) });
  try {
    // Neither awaited before stop.
    const meta = service.saveMetadata("demo-book", null, {
      toc: { title: "C" },
    });
    const text = service.saveManuscript("demo-book", { text: "{title}\nY\n" });
    await service.stop();
    assertEquals(
      (await readJson(`${root}/demo-book/metadata.json`)).toc,
      { title: "C" },
    );
    assertEquals(
      await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
      "{title}\nY\n",
    );
    await Promise.all([meta, text]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("images: list by slug; add names from the file, never overwrites", async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/demo-book/images`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${root}/demo-book/manuscript.md`, "{title}\nX\n");
  await Deno.writeTextFile(`${dir}/ornament.svg`, "<svg/>");
  await Deno.writeTextFile(`${dir}/marleys-ghost.jpg`, "jpg");
  await Deno.writeTextFile(`${dir}/notes.txt`, "not an image");
  const service = new BookService({ store: diskStore(root) });
  try {
    assertEquals(await service.images("demo-book"), [
      { slug: "marleys-ghost", name: "marleys-ghost.jpg" },
      { slug: "ornament", name: "ornament.svg" },
    ]);

    // Taken under another extension: the .png would be shadowed, so -2.
    assertEquals(
      await service.addImage("demo-book", "Marley's Ghost.png", bytes("png")),
      { slug: "marleys-ghost-2", name: "marleys-ghost-2.png" },
    );
    assertEquals(await Deno.readTextFile(`${dir}/marleys-ghost.jpg`), "jpg");
    assertEquals(await Deno.readTextFile(`${dir}/marleys-ghost-2.png`), "png");

    // A given slug is used as is, refused when taken or malformed.
    assertEquals(
      await service.addImage("demo-book", "a.JPEG", bytes("x"), "plate_1"),
      { slug: "plate_1", name: "plate_1.jpeg" },
    );
    const status = async (p: Promise<unknown>) =>
      (await assertRejects(() => p, ServiceError)).status;
    assertEquals(
      await status(
        service.addImage("demo-book", "b.png", bytes("y"), "ornament"),
      ),
      409,
    );
    for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "a\u0007b"]) {
      assertEquals(
        await status(service.addImage("demo-book", "b.png", bytes("y"), bad)),
        400,
        JSON.stringify(bad),
      );
    }
    // Any slug BML allows that is safe as a file name; the resolver slices
    // at the last dot, so orchard.1943.png serves orchard.1943.
    for (const slug of ["orchard.1943", "Orchard 1943"]) {
      assertEquals(
        await service.addImage("demo-book", "b.png", bytes("y"), slug),
        { slug, name: `${slug}.png` },
      );
    }
    assertEquals(
      (await imageFiles(diskStore(root), "demo-book"))["orchard.1943"],
      "orchard.1943.png",
    );
    assertEquals(
      await service.image("demo-book", "Orchard 1943.png"),
      bytes("y"),
    );
    // A file the renderer can't show neither lists nor takes its slug.
    await Deno.writeTextFile(`${dir}/harbour.tif`, "tif");
    assertEquals(
      await service.addImage("demo-book", "h.png", bytes("h"), "harbour"),
      { slug: "harbour", name: "harbour.png" },
    );
    assertEquals(await Deno.readTextFile(`${dir}/harbour.tif`), "tif");
    const heic = await assertRejects(
      () => service.addImage("demo-book", "x.heic", bytes("z")),
      ServiceError,
    );
    assertEquals(heic.status, 415);
    assertEquals(
      heic.message,
      "Only PNG, JPEG, WebP or SVG images can go in a book",
    );
    assertEquals(await Deno.readTextFile(`${dir}/ornament.svg`), "<svg/>");
    assertEquals(
      await status(service.images("no-such-book")),
      404,
    );
  } finally {
    await service.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("importBook: a new book's images/ is made for its pictures", async () => {
  const root = await Deno.makeTempDir();
  const service = new BookService({ store: diskStore(root) });
  try {
    assertEquals(
      await service.importBook("pics", "{}", {
        manuscript: "{title}\nPics\n",
        images: { "images/p.png": bytes("png") },
      }),
      true,
    );
    assertEquals(await Deno.readTextFile(`${root}/pics/images/p.png`), "png");
  } finally {
    await service.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("list: a folder named Old Drafts is skipped and named", async () => {
  const files = new Map([
    ["demo-book/manuscript.md", bytes("{title}\nX\n")],
    ["Old Drafts/manuscript.md", bytes("{title}\nY\n")],
  ]);
  const service = new BookService({ store: memoryStore(files) });
  try {
    assertEquals(await service.list(), {
      books: ["demo-book"],
      skipped: ["Old Drafts"],
    });
  } finally {
    await service.stop();
  }
});

// Two tabs over one library: two services, each over its own withTabs store
// on one shared Map (memoryStore reports only its own writes, so the other
// tab hears of a write only through the channel), sharing one lock — the
// test's stand-in for navigator.locks.
function tabs() {
  const files = new Map([
    ["demo-book/manuscript.md", bytes("{title}\nX\n")],
  ]);
  const tails = new Map<string, Promise<unknown>>();
  const lock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn);
    tails.set(key, run.catch(() => {}));
    return run;
  };
  const channel = `test-${crypto.randomUUID()}`;
  const tab = () =>
    new BookService({ store: withTabs(memoryStore(files), channel), lock });
  return [tab(), tab()] as const;
}
Deno.test("tabs: a write reaches its own tab's watch once", async () => {
  const store = withTabs(memoryStore(), `test-${crypto.randomUUID()}`);
  const heard: string[][] = [];
  const stop = store.watch((paths) => heard.push(paths));
  try {
    await store.write("demo-book/manuscript.md", "X\n");
    await until(() => heard.length > 0);
    await quietFor(50); // an echo would be in by now
    assertEquals(heard, [["demo-book/manuscript.md"]]);
  } finally {
    stop();
  }
});

Deno.test("tabs: two services over one library each see the other's save", async () => {
  const [a, b] = tabs();
  try {
    for (const [from, to, text] of [[a, b, "Y"], [b, a, "Z"]] as const) {
      const seen: ServerMessage[] = [];
      const unsubscribe = to.subscribe("demo-book", null, "c", (m) => {
        seen.push(m);
      });
      const saved = await from.saveManuscript("demo-book", {
        text: `{title}\n${text}\n`,
      });
      assertEquals("ok" in saved, true);
      const version = "version" in saved ? saved.version : "";
      await until(
        () =>
          seen.some((m) =>
            m.type === "update" && m.manuscriptVersion === version
          ),
        `${text} to reach the other tab`,
      );
      unsubscribe();
    }
  } finally {
    await a.stop();
    await b.stop();
  }
});

Deno.test("tabs: concurrent saves from one base across services — one lands, one 409", async () => {
  const [a, b] = tabs();
  try {
    const base = (await a.manuscript("demo-book")).version;
    const results = await Promise.all([
      a.saveManuscript("demo-book", { text: "{title}\nA\n", base }),
      b.saveManuscript("demo-book", { text: "{title}\nB\n", base }),
    ]);
    const landed = results.filter((r) => "ok" in r);
    const refused = results.filter((r) => "conflict" in r);
    assertEquals([landed.length, refused.length], [1, 1]);
    // The refused one is handed what landed.
    const current = await b.manuscript("demo-book");
    assertEquals(refused[0]?.text, current.text);
    assertEquals(landed[0]?.version, current.version);
  } finally {
    await a.stop();
    await b.stop();
  }
});

// The fixture book and its pocket edition in memory: a save's broadcast needs
// no disk, watch or clock.
async function demoService(): Promise<BookService> {
  const src = new URL("./testdata/demo-book/", import.meta.url);
  const files = new Map<string, Uint8Array>();
  for (const f of ["manuscript.md", "metadata.json", "editions/pocket.json"]) {
    files.set(`demo-book/${f}`, await Deno.readFile(new URL(f, src)));
  }
  return new BookService({ store: memoryStore(files) });
}

// The updates a client on `edition` is sent, as they arrive.
function listen(service: BookService, edition: string | null, client: string) {
  const heard: Extract<ServerMessage, { type: "update" }>[] = [];
  service.subscribe("demo-book", edition, client, (m) => {
    if (m.type === "update") heard.push(m);
  });
  return heard;
}

Deno.test("metadata: a save broadcasts an update with its version", async () => {
  const service = await demoService();
  try {
    const heard = listen(service, null, "cfg-1");
    await until(() => heard.length > 0, "the initial build");
    const { version } = await service.saveMetadata("demo-book", null, {
      notes: { placement: "footnote" },
    });
    await until(
      () => heard.some((m) => m.metadataVersion === version),
      "the save's broadcast",
    );
    const msg = heard.find((m) => m.metadataVersion === version)!;
    assertEquals("origin" in msg, false);
    assert(msg.pagedCss.includes("float: footnote"));
  } finally {
    await service.stop();
  }
});

Deno.test("editions: clients hear their own edition's builds; manuscript edits reach all", async () => {
  const service = await demoService();
  try {
    const unnamed = listen(service, null, "u");
    const pocket = listen(service, "pocket", "p");
    await until(
      () => unnamed.length > 0 && pocket.length > 0,
      "both initial builds",
    );
    assertEquals([unnamed[0]!.edition, pocket[0]!.edition], [null, "pocket"]);
    assert(pocket[0]!.pagedCss.includes("3.5in 5in"));

    // A pocket save reaches the pocket client only. A broadcast sends to all
    // its clients at once, so by the time pocket has it, so would unnamed.
    const { version } = await service.saveMetadata("demo-book", "pocket", {
      notes: { placement: "footnote" },
    });
    await until(
      () => pocket.some((m) => m.metadataVersion === version),
      "the pocket save's broadcast",
    );
    assert(
      pocket.find((m) => m.metadataVersion === version)!.pagedCss.includes(
        "float: footnote",
      ),
    );
    assert(!unnamed.some((m) => m.pagedCss.includes("float: footnote")));

    // A manuscript save reaches both, each built with its own edition.
    const saved = await service.saveManuscript("demo-book", {
      text: "{matter: half-title}\n{title}\nRenamed\n",
    });
    const v = "version" in saved ? saved.version : "";
    const of = (heard: typeof unnamed) =>
      heard.find((m) => m.manuscriptVersion === v);
    await until(() => !!of(unnamed) && !!of(pocket), "both rebuilds");
    assert(of(unnamed)!.pagedCss.includes("5.5in 8.5in"));
    assert(of(pocket)!.pagedCss.includes("3.5in 5in"));
  } finally {
    await service.stop();
  }
});
