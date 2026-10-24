// server/dev-server_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { startServer } from "./dev-server.ts";
import { contentVersion } from "./pipeline.ts";

// Tests copy the fixture into a temp dir: later tasks write to it, and the
// watcher must not fire on tracked files under server/testdata/.
export async function makeBooksRoot(): Promise<string> {
  const root = await Deno.makeTempDir();
  const src = new URL("./testdata/demo-book/", import.meta.url);
  await Deno.mkdir(`${root}/demo-book/images`, { recursive: true });
  for (const f of ["manuscript.md", "metadata.json"]) {
    await Deno.copyFile(new URL(f, src), `${root}/demo-book/${f}`);
  }
  await Deno.copyFile(
    new URL("images/ornament.svg", src),
    `${root}/demo-book/images/ornament.svg`,
  );
  await Deno.mkdir(`${root}/demo-book/editions`);
  await Deno.copyFile(
    new URL("editions/pocket.json", src),
    `${root}/demo-book/editions/pocket.json`,
  );
  return root;
}

Deno.test("http: shell, book list, build json, images, 404s", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const base = `http://localhost:${server.port}`;
  try {
    const shell = await fetch(`${base}/app/`);
    assertEquals(shell.status, 200);
    assert((await shell.text()).includes('id="preview"'));
    // The root is the site's front page; a bare directory redirects.
    assert((await (await fetch(`${base}/`)).text()).includes('href="/app/"'));
    const bare = await fetch(`${base}/about`, { redirect: "manual" });
    assertEquals(bare.status, 301);
    assertEquals(bare.headers.get("location"), `${base}/about/`);
    await bare.body?.cancel();

    const books = await (await fetch(`${base}/api/books`)).json();
    assertEquals(books, { books: ["demo-book"] });

    // The library id is minted into library.json once and then stable.
    const { id } = await (await fetch(`${base}/api/library`)).json();
    assert(/^[0-9a-f]{8}$/.test(id));
    assertEquals(JSON.parse(await Deno.readTextFile(`${root}/library.json`)), {
      id,
    });
    assertEquals((await (await fetch(`${base}/api/library`)).json()).id, id);

    const build = await (await fetch(`${base}/api/books/demo-book`)).json();
    assert(build.html.includes("Chapter One"));
    assert(build.pagedCss.includes("@page"));

    const img = await fetch(`${base}/books/demo-book/images/ornament.svg`);
    assertEquals(img.status, 200);
    assertEquals(img.headers.get("content-type"), "image/svg+xml");
    await img.body?.cancel();

    // robots.txt sits at the root, as the static host serves it.
    const robots = await fetch(`${base}/robots.txt`);
    assertEquals(robots.status, 200);
    assertEquals(
      robots.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    await robots.body?.cancel();

    const missing = await fetch(`${base}/api/books/no-such-book`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const traversal = await fetch(`${base}/books/..%2F..%2Fetc/images/passwd`);
    assert(traversal.status === 400 || traversal.status === 404);
    await traversal.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

function nextMessage(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("timed out waiting for a ws message")),
      timeoutMs,
    );
    ws.addEventListener("message", (e) => {
      clearTimeout(t);
      resolve(JSON.parse((e as MessageEvent).data));
    }, { once: true });
  });
}

function nextMessageWhere(
  ws: WebSocket,
  pred: (m: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("timed out waiting for a matching ws message")),
      timeoutMs,
    );
    const onMessage = (e: Event) => {
      const m = JSON.parse((e as MessageEvent).data);
      if (!pred(m)) return;
      clearTimeout(t);
      ws.removeEventListener("message", onMessage);
      resolve(m);
    };
    ws.addEventListener("message", onMessage);
  });
}

Deno.test("websocket: initial build on connect, rebuild pushed on file change", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=t1`,
  );
  try {
    const first = await nextMessage(ws);
    assertEquals(first.type, "update");
    assertEquals("origin" in first, false);
    assert((first.html as string).includes("Chapter One"));

    // Give the fresh FSEvents watch a beat before the write it must see.
    await new Promise((r) => setTimeout(r, 300));
    const pushed = nextMessage(ws);
    const manuscript = `${root}/demo-book/manuscript.md`;
    const src = await Deno.readTextFile(manuscript);
    await Deno.writeTextFile(
      manuscript,
      src.replace("Chapter One", "Chapter Won"),
    );

    const msg = await pushed;
    assertEquals(msg.type, "update");
    assertEquals(
      msg.manuscriptVersion,
      await contentVersion(src.replace("Chapter One", "Chapter Won")),
    );
    assertEquals(msg.metadataVersion, first.metadataVersion);
    assert((msg.html as string).includes("Chapter Won"));
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("save: each post lands before it is answered; POST and broadcast carry the version", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const base = `http://localhost:${server.port}`;
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=observer`,
  );
  const manuscript = `${root}/demo-book/manuscript.md`;
  try {
    await nextMessage(ws); // initial build
    await new Promise((r) => setTimeout(r, 300)); // let the watch warm up

    const post = (text: string) =>
      fetch(`${base}/api/books/demo-book/manuscript`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, clientId: "editor-1" }),
      });

    const draftA = "{chapter: draft}\n{title}\nDraft A\n";
    const draftB = "{chapter: draft}\n{title}\nDraft B\n";
    const r1 = await post(draftA);
    assertEquals(r1.status, 200);
    assertEquals(await r1.json(), {
      ok: true,
      version: await contentVersion(draftA),
    });
    assertEquals(await Deno.readTextFile(manuscript), draftA);
    const versionB = await contentVersion(draftB);
    const pushed = nextMessageWhere(
      ws,
      (m) => m.manuscriptVersion === versionB,
    );
    const r2 = await post(draftB);
    assertEquals(r2.status, 200);
    assertEquals((await r2.json()).version, versionB);
    assertEquals(await Deno.readTextFile(manuscript), draftB);

    const msg = await pushed;
    assertEquals(msg.type, "update");
    assertEquals("origin" in msg, false);
    assert((msg.html as string).includes("Draft B"));

    const bad = await fetch(`${base}/api/books/demo-book/manuscript`, {
      method: "POST",
      body: "not json",
    });
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("save: a failed write is a 500 with the error, and nothing lands", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const dir = `${root}/demo-book`;
  const before = await Deno.readTextFile(`${dir}/manuscript.md`);
  try {
    await Deno.chmod(dir, 0o555); // readable, but the tmp file can't be made
    const res = await fetch(
      `http://localhost:${server.port}/api/books/demo-book/manuscript`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "won't land" }),
      },
    );
    assertEquals(res.status, 500);
    assert((await res.text()).startsWith("save failed:"));
    assertEquals(await Deno.readTextFile(`${dir}/manuscript.md`), before);
  } finally {
    await Deno.chmod(dir, 0o755);
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("save: stale base gets 409 with the disk text", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const url = `http://localhost:${server.port}/api/books/demo-book/manuscript`;
  const manuscript = `${root}/demo-book/manuscript.md`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const got = await (await fetch(url)).json();
    assertEquals(got.version, await contentVersion(got.text));

    // Another writer changes the file after this editor loaded it.
    const external = "{chapter: one}\nChanged elsewhere.\n";
    await Deno.writeTextFile(manuscript, external);
    const stale = await post({ text: "mine", base: got.version });
    assertEquals(stale.status, 409);
    assertEquals(await stale.json(), {
      conflict: true,
      text: external,
      version: await contentVersion(external),
    });
    assertEquals(await Deno.readTextFile(manuscript), external);

    // Based on the current version it lands; the next save may be based on
    // the version that one returned.
    const ok = await post({
      text: "mine 1",
      base: await contentVersion(external),
    });
    assertEquals(ok.status, 200);
    const { version } = await ok.json();
    const next = await post({ text: "mine 2", base: version });
    assertEquals(next.status, 200);
    const { version: v2 } = await next.json();

    // A write from outside between two saves: the second is refused.
    await Deno.writeTextFile(manuscript, "theirs");
    const late = await post({ text: "mine 3", base: v2 });
    assertEquals(late.status, 409);
    assertEquals((await late.json()).text, "theirs");
    assertEquals(await Deno.readTextFile(manuscript), "theirs");

    // A missing base skips the check.
    const noBase = await post({ text: "mine 4" });
    assertEquals(noBase.status, 200);
    await noBase.body?.cancel();
    assertEquals(await Deno.readTextFile(manuscript), "mine 4");
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("save: concurrent saves from one base — one lands, the other gets 409", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const url = `http://localhost:${server.port}/api/books/demo-book/manuscript`;
  const post = (text: string, base: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, base }),
    });
  try {
    const { version } = await (await fetch(url)).json();
    const [a, b] = await Promise.all([
      post("tab A", version),
      post("tab B", version),
    ]);
    assertEquals([a.status, b.status].sort(), [200, 409]);
    const won = a.status === 200 ? "tab A" : "tab B";
    const lost = await (a.status === 409 ? a : b).json();
    await (a.status === 200 ? a : b).body?.cancel();
    assertEquals(lost.text, won); // the loser is shown what landed
    assertEquals(
      await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
      won,
    );
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("http: GET manuscript returns source; saves read through", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const base = `http://localhost:${server.port}`;
  try {
    const res = await fetch(`${base}/api/books/demo-book/manuscript`);
    assertEquals(res.status, 200);
    const { text, version } = await res.json();
    assert(text.includes("{chapter: one}"));
    assertEquals(
      version,
      await contentVersion(
        await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
      ),
    );

    const post = await fetch(`${base}/api/books/demo-book/manuscript`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "{chapter: two}\nNew text.",
        clientId: "t1",
      }),
    });
    assertEquals((await post.json()).ok, true);
    const after = await (await fetch(`${base}/api/books/demo-book/manuscript`))
      .json();
    assertEquals(after.text, "{chapter: two}\nNew text.");
    assertEquals(after.version, await contentVersion(after.text));

    const missing = await fetch(`${base}/api/books/no-such/manuscript`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("save: unknown book is a 404", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  try {
    const res = await fetch(
      `http://localhost:${server.port}/api/books/no-such-book/manuscript`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x", clientId: "c" }),
      },
    );
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata: GET returns config; POST merges sections, preserves the rest", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  try {
    const res = await fetch(`${base}/api/books/demo-book/metadata`);
    assertEquals(res.status, 200);
    const { metadata, version } = await res.json();
    assertEquals(
      version,
      await contentVersion(
        await Deno.readTextFile(`${root}/demo-book/metadata.json`),
      ),
    );
    assertEquals(metadata.page.size, "5.5in 8.5in"); // fixture content
    assert(metadata.elements); // fixture has sentinel styles — must survive saves

    const post = await fetch(`${base}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: { page: { size: "A5" } },
        clientId: "t1",
      }),
    });
    const posted = await post.json();
    assertEquals(posted.ok, true);

    // Pending save reads through before the debounce flushes.
    const during = await (await fetch(`${base}/api/books/demo-book/metadata`))
      .json();
    assertEquals(during.metadata.page.size, "A5");
    assertEquals(during.version, posted.version);

    await new Promise((r) => setTimeout(r, 150));
    // The version is of exactly the text that was written.
    assertEquals(
      posted.version,
      await contentVersion(
        await Deno.readTextFile(`${root}/demo-book/metadata.json`),
      ),
    );
    const onDisk = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/metadata.json`),
    );
    assertEquals(onDisk.page.size, "A5"); // POSTed section replaced wholesale
    assertEquals(onDisk.elements, metadata.elements); // untouched section preserved
    assertEquals(onDisk.fonts, metadata.fonts); // untouched section preserved

    // null deletes a section outright.
    await (await fetch(`${base}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: { numbering: null } }),
    })).body?.cancel();
    await new Promise((r) => setTimeout(r, 150));
    const afterDelete = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/metadata.json`),
    );
    assertEquals("numbering" in afterDelete, false);

    const missing = await fetch(`${base}/api/books/no-such/metadata`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const badBody = await fetch(`${base}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [1, 2] }),
    });
    assertEquals(badBody.status, 400);
    await badBody.body?.cancel();

    // Corrupt file: both methods refuse rather than lose data.
    await Deno.writeTextFile(`${root}/demo-book/metadata.json`, "{ not json");
    const corruptGet = await fetch(`${base}/api/books/demo-book/metadata`);
    assertEquals(corruptGet.status, 409);
    await corruptGet.body?.cancel();
    const corruptPost = await fetch(`${base}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: { page: {} } }),
    });
    assertEquals(corruptPost.status, 409);
    await corruptPost.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata: missing metadata.json GETs as {} and POST creates it", async () => {
  const root = await makeBooksRoot();
  await Deno.remove(`${root}/demo-book/metadata.json`);
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  try {
    const empty = await (await fetch(`${base}/api/books/demo-book/metadata`))
      .json();
    assertEquals(empty, { metadata: {}, version: null });

    await (await fetch(`${base}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: { notes: { placement: "endnote" } } }),
    })).body?.cancel();
    await new Promise((r) => setTimeout(r, 150));
    const created = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/metadata.json`),
    );
    assertEquals(created, { notes: { placement: "endnote" } });
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata: debounced write broadcasts an update with the POSTed version", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=cfg-1`,
  );
  try {
    await nextMessage(ws); // initial build
    await new Promise((r) => setTimeout(r, 300)); // let the watch warm up
    const pushed = nextMessage(ws);

    const post = await fetch(
      `http://localhost:${server.port}/api/books/demo-book/metadata`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sections: { notes: { placement: "footnote" } },
          clientId: "cfg-1",
        }),
      },
    );
    const { ok, version } = await post.json();
    assertEquals(ok, true);

    const msg = await pushed;
    assertEquals(msg.type, "update");
    assertEquals("origin" in msg, false);
    assertEquals(msg.metadataVersion, version); // spec §6: echo known by version
    assert((msg.pagedCss as string).includes("float: footnote"));
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata: an outside edit to another section during the debounce survives", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 200,
  });
  const path = `${root}/demo-book/metadata.json`;
  const post = (sections: unknown) =>
    fetch(`http://localhost:${server.port}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections }),
    }).then((r) => r.body?.cancel());
  try {
    await post({ notes: { placement: "footnote" } });
    // Another writer names the edition while the save is still debounced.
    const disk = JSON.parse(await Deno.readTextFile(path));
    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...disk, name: "External" }, null, 2),
    );
    await post({ toc: { title: "Contents" } }); // same window, accumulates
    await new Promise((r) => setTimeout(r, 400));
    const saved = JSON.parse(await Deno.readTextFile(path));
    assertEquals(saved.name, "External");
    assertEquals(saved.notes, { placement: "footnote" });
    assertEquals(saved.toc, { title: "Contents" });
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata: a failed debounced write reaches the edition's editors as a save error", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 150,
  });
  const base = `http://localhost:${server.port}`;
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=observer`,
  );
  try {
    await nextMessage(ws); // initial build
    const failed = nextMessageWhere(ws, (m) => m.save === "metadata");
    // Accepted at once; the write happens after the debounce.
    const post = await fetch(`${base}/api/books/demo-book/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: { notes: { placement: "footnote" } } }),
    });
    assertEquals(post.status, 200);
    await post.body?.cancel();

    // Yank the book out from under the pending write.
    await Deno.remove(`${root}/demo-book`, { recursive: true });
    const msg = await failed;
    assertEquals(msg.type, "error");
    assertEquals(msg.book, "demo-book");
    assertEquals(msg.edition, null);
    assert((msg.message as string).startsWith("save failed:"));

    // Server must still be alive and serving other requests.
    const books = await (await fetch(`${base}/api/books`)).json();
    assertEquals(books, { books: [] });
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("editions: list, build json per edition, metadata GET/POST touch only that file", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  try {
    const list = await (await fetch(`${base}/api/books/demo-book/editions`))
      .json();
    assertEquals(list, {
      editions: [
        {
          slug: null,
          name: "Standard",
          summary: "5.5in × 8.5in · folio on letter · EB Garamond · 11pt",
          passages: 0,
        },
        {
          slug: "pocket",
          name: "Pocket",
          summary: "3.5in 5in · Crimson Pro · 9pt",
          passages: 0,
        },
      ],
    });

    const build =
      await (await fetch(`${base}/api/books/demo-book?edition=pocket`)).json();
    assertEquals(build.edition, "pocket");
    assert(build.pagedCss.includes("3.5in 5in"));

    const missing = await fetch(`${base}/api/books/demo-book?edition=nope`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();

    const get = await (await fetch(
      `${base}/api/books/demo-book/editions/pocket/metadata`,
    )).json();
    assertEquals(get.metadata.page.size, "3.5in 5in");
    assertEquals(
      get.version,
      await contentVersion(
        await Deno.readTextFile(`${root}/demo-book/editions/pocket.json`),
      ),
    );

    const post = await fetch(
      `${base}/api/books/demo-book/editions/pocket/metadata`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sections: { page: { size: "A6" } },
          clientId: "t1",
        }),
      },
    );
    assertEquals((await post.json()).ok, true);
    await new Promise((r) => setTimeout(r, 150));
    const pocket = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/editions/pocket.json`),
    );
    assertEquals(pocket.page.size, "A6");
    assertEquals(pocket.fonts, { body: "Crimson Pro" }); // rest preserved
    const unnamed = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/metadata.json`),
    );
    assertEquals(unnamed.page.size, "5.5in 8.5in"); // untouched

    const unknown = await fetch(
      `${base}/api/books/demo-book/editions/nope/metadata`,
    );
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("editions: create copies the source's current metadata; rename; delete", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    // A pending (not yet flushed) save on the unnamed edition must be what gets copied.
    await (await fetch(
      `${base}/api/books/demo-book/metadata`,
      json({
        sections: { page: { size: "A5" } },
      }),
    )).body?.cancel();

    const created = await fetch(
      `${base}/api/books/demo-book/editions`,
      json({ slug: "gift" }),
    );
    assertEquals(created.status, 201);
    await created.body?.cancel();
    const gift = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/editions/gift.json`),
    );
    assertEquals(gift.page.size, "A5");
    assertEquals(gift.fonts, { body: "EB Garamond" });

    const fromPocket = await fetch(
      `${base}/api/books/demo-book/editions`,
      json({
        slug: "pocket-2",
        from: "pocket",
      }),
    );
    assertEquals(fromPocket.status, 201);
    await fromPocket.body?.cancel();
    const p2 = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/editions/pocket-2.json`),
    );
    assertEquals(p2.page.size, "3.5in 5in");

    const dup = await fetch(
      `${base}/api/books/demo-book/editions`,
      json({ slug: "gift" }),
    );
    assertEquals(dup.status, 409);
    await dup.body?.cancel();
    const bad = await fetch(
      `${base}/api/books/demo-book/editions`,
      json({ slug: "../x" }),
    );
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
    const noFrom = await fetch(
      `${base}/api/books/demo-book/editions`,
      json({
        slug: "z",
        from: "nope",
      }),
    );
    assertEquals(noFrom.status, 404);
    await noFrom.body?.cancel();

    const renamed = await fetch(
      `${base}/api/books/demo-book/editions/gift/rename`,
      json({
        slug: "deluxe",
      }),
    );
    assertEquals((await renamed.json()).ok, true);
    await Deno.stat(`${root}/demo-book/editions/deluxe.json`);
    const clash = await fetch(
      `${base}/api/books/demo-book/editions/deluxe/rename`,
      json({
        slug: "pocket",
      }),
    );
    assertEquals(clash.status, 409);
    await clash.body?.cancel();

    const del = await fetch(`${base}/api/books/demo-book/editions/deluxe`, {
      method: "DELETE",
    });
    assertEquals((await del.json()).ok, true);
    await assertRejects(() =>
      Deno.stat(`${root}/demo-book/editions/deluxe.json`)
    );
    const delMissing = await fetch(
      `${base}/api/books/demo-book/editions/deluxe`,
      { method: "DELETE" },
    );
    assertEquals(delMissing.status, 404);
    await delMissing.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rename rewrites {only} tokens in manuscript.md", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/books/demo-book${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    // The landed manuscript's old token is what gets rewritten.
    await (await post("/manuscript", {
      text: "{chapter: one}\n\n{only: pocket | default}\nP\n{/only}\n",
    })).body?.cancel();
    const renamed = await post("/editions/pocket/rename", { slug: "travel" });
    assertEquals((await renamed.json()).ok, true);
    assertEquals(
      await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
      "{chapter: one}\n\n{only: travel | default}\nP\n{/only}\n",
    );
    await Deno.stat(`${root}/demo-book/editions/travel.json`);

    // `default` is reserved: never a new slug, never a rename target.
    for (
      const r of [
        await post("/editions", { slug: "default" }),
        await post("/editions/travel/rename", { slug: "default" }),
      ]
    ) {
      assertEquals(r.status, 400);
      await r.body?.cancel();
    }
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rename: a stale save carrying the old token lands with the new one", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/books/demo-book${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // A tab open on the book before the rename, so its later saves are stale.
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=tab`,
  );
  const manuscript = `${root}/demo-book/manuscript.md`;
  const settle = () => new Promise((r) => setTimeout(r, 150));
  try {
    await nextMessage(ws);
    const renamed = await post("/editions/pocket/rename", { slug: "travel" });
    assertEquals((await renamed.json()).ok, true);
    await (await post("/manuscript", {
      text: "{chapter: one}\n\n{only: pocket | default}\nP\n{/only}\n",
      clientId: "tab",
    })).body?.cancel();
    await settle();
    assertEquals(
      await Deno.readTextFile(manuscript),
      "{chapter: one}\n\n{only: travel | default}\nP\n{/only}\n",
    );
    // Once the tab saves without the old token it has caught up: `pocket`
    // is free again for a new edition of that name.
    await (await post("/manuscript", {
      text: "{chapter: one}\n",
      clientId: "tab",
    }))
      .body?.cancel();
    await (await post("/manuscript", {
      text: "{chapter: one}\n\n{only: pocket}\nP\n{/only}\n",
      clientId: "tab",
    })).body?.cancel();
    await settle();
    assertEquals(
      await Deno.readTextFile(manuscript),
      "{chapter: one}\n\n{only: pocket}\nP\n{/only}\n",
    );
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rename: a rewritten save returns text; an untouched one does not", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/books/demo-book${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=tab`,
  );
  try {
    await nextMessage(ws);
    await (await post("/editions/pocket/rename", { slug: "travel" })).json();
    const rewritten = "{chapter: one}\n\n{only: travel}\nP\n{/only}\n";
    const res = await post("/manuscript", {
      text: "{chapter: one}\n\n{only: pocket}\nP\n{/only}\n",
      clientId: "tab",
    });
    assertEquals(await res.json(), {
      ok: true,
      version: await contentVersion(rewritten),
      text: rewritten,
    });
    const plain = await post("/manuscript", {
      text: "{chapter: one}\n",
      clientId: "tab",
    });
    assertEquals("text" in await plain.json(), false);
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("editions: the default edition renames by display name, through the pending save", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/books/demo-book${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    // A debounced metadata edit must survive the rename, not be clobbered.
    await (await post("/metadata", { sections: { page: { size: "A5" } } }))
      .body?.cancel();
    const r = await post("/editions/default/rename", { name: " Hardcover " });
    assertEquals((await r.json()).ok, true);
    const meta = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/metadata.json`),
    );
    assertEquals(meta.name, "Hardcover");
    assertEquals(meta.page.size, "A5");
    const list = await (await fetch(`${base}/api/books/demo-book/editions`))
      .json();
    assertEquals(list.editions[0].name, "Hardcover");

    // A clone does not take the default edition's name.
    await (await post("/editions", { slug: "gift", from: "default" })).body
      ?.cancel();
    const gift = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/editions/gift.json`),
    );
    assertEquals(gift.name, undefined);
    assertEquals(gift.page.size, "A5");

    const bad = await post("/editions/default/rename", { name: 3 });
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("editions: ws clients get their own edition's builds; manuscript edits reach all", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 40,
  });
  const base = `http://localhost:${server.port}`;
  const unnamed = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=u`,
  );
  const pocket = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&edition=pocket&client=p`,
  );
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.body?.cancel());
  try {
    // Attach both listeners before awaiting either, or the second socket's
    // initial message arrives before anyone is listening and is lost.
    const u0p = nextMessage(unnamed);
    const p0p = nextMessage(pocket);
    const u0 = await u0p;
    const p0 = await p0p;
    assertEquals(u0.edition, null);
    assertEquals(p0.edition, "pocket");
    assert((p0.pagedCss as string).includes("3.5in 5in"));
    await new Promise((r) => setTimeout(r, 300)); // let the watch warm up

    // Pocket metadata write → only the pocket client hears it.
    let unnamedHeard = false;
    unnamed.addEventListener("message", () => unnamedHeard = true, {
      once: true,
    });
    const p1 = nextMessageWhere(
      pocket,
      (m) => m.metadataVersion !== p0.metadataVersion,
    );
    await post(`${base}/api/books/demo-book/editions/pocket/metadata`, {
      sections: { notes: { placement: "footnote" } },
    });
    const msg = await p1;
    assertEquals(msg.edition, "pocket");
    assert((msg.pagedCss as string).includes("float: footnote"));
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(unnamedHeard, false);

    // Manuscript write → both clients, each built with its own edition.
    const text = "{matter: half-title}\n{title}\nRenamed\n";
    const version = await contentVersion(text);
    const u2 = nextMessageWhere(
      unnamed,
      (m) => m.manuscriptVersion === version,
    );
    const p2 = nextMessageWhere(pocket, (m) => m.manuscriptVersion === version);
    await post(`${base}/api/books/demo-book/manuscript`, { text });
    const [um, pm] = await Promise.all([u2, p2]);
    assert((um.pagedCss as string).includes("5.5in 8.5in"));
    assert((pm.pagedCss as string).includes("3.5in 5in"));
  } finally {
    unnamed.close();
    pocket.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("try: builds in the posted style, writes nothing; bad body 400, missing edition 404", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const url = `http://localhost:${server.port}/api/books/demo-book/try`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const file = `${root}/demo-book/metadata.json`;
    const before = await Deno.readTextFile(file);
    const ok = await post({
      edition: null,
      metadata: { fonts: { body: "Playfair Display" } },
    });
    assertEquals(ok.status, 200);
    const built = await ok.json();
    assert(built.fontLinks.includes("family=Playfair+Display"));
    assertEquals(built.metadataVersion, await contentVersion(before));
    assertEquals(await Deno.readTextFile(file), before);

    for (
      const bad of [
        { edition: null },
        { edition: 3, metadata: {} },
        { edition: null, metadata: [] },
        { edition: null, metadata: null },
      ]
    ) {
      const res = await post(bad);
      assertEquals(res.status, 400);
      await res.body?.cancel();
    }
    const missing = await post({ edition: "nope", metadata: {} });
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("create and import: a posted theme's fonts; unknown theme 400", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const fonts = async (book: string) =>
    JSON.parse(await Deno.readTextFile(`${root}/${book}/metadata.json`)).fonts;
  try {
    const made = await post("/api/books", { slug: "c", theme: "caslon" });
    assertEquals(made.status, 201);
    await made.body?.cancel();
    assertEquals((await fonts("c")).body, "Libre Caslon Text");

    const imported = await post("/api/books/i/import", {
      manuscript: "{title}\nI\n",
      images: {},
      theme: "caslon",
    });
    assertEquals(imported.status, 201);
    await imported.body?.cancel();
    assertEquals((await fonts("i")).display, "Libre Caslon Display");

    for (
      const [path, body] of [
        ["/api/books", { slug: "u", theme: "nope" }],
        ["/api/books", { slug: "u", theme: 3 }],
        ["/api/books/u/import", { manuscript: "", images: {}, theme: "nope" }],
      ] as const
    ) {
      const res = await post(path, body);
      assertEquals(res.status, 400);
      await res.body?.cancel();
    }
    await assertRejects(() => Deno.stat(`${root}/u`));
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("dictionary: words added land sorted in dictionary.json; a broken file is never overwritten", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const url = `http://localhost:${server.port}/api/books/demo-book/dictionary`;
  const add = (word: string) =>
    fetch(url, { method: "POST", body: JSON.stringify({ word }) });
  try {
    assertEquals(await (await fetch(url)).json(), { words: [] });
    await (await add("Gatsby")).body?.cancel();
    assertEquals(await (await add("Daisy")).json(), {
      words: ["Daisy", "Gatsby"],
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${root}/demo-book/dictionary.json`)),
      { words: ["Daisy", "Gatsby"] },
    );
    const spaced = await add("two words");
    assertEquals(spaced.status, 400);
    await spaced.body?.cancel();

    await Deno.writeTextFile(`${root}/demo-book/dictionary.json`, "{ oops");
    const broken = await add("Nick");
    assertEquals(broken.status, 409);
    await broken.body?.cancel();
    assertEquals(
      await Deno.readTextFile(`${root}/demo-book/dictionary.json`),
      "{ oops",
    );
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("images: GET lists, POST adds the body under a free name; bad type 415", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const url = `http://localhost:${server.port}/api/books/demo-book/images`;
  const add = (filename: string, body: string, slug?: string) =>
    fetch(
      `${url}?filename=${encodeURIComponent(filename)}${
        slug ? `&slug=${slug}` : ""
      }`,
      { method: "POST", body },
    );
  try {
    assertEquals(await (await fetch(url)).json(), {
      images: [{ slug: "ornament", name: "ornament.svg" }],
    });
    const added = await add("Ornament.PNG", "png");
    assertEquals(added.status, 201);
    assertEquals(await added.json(), {
      slug: "ornament-2",
      name: "ornament-2.png",
    });
    assertEquals(
      await Deno.readTextFile(`${root}/demo-book/images/ornament-2.png`),
      "png",
    );
    const taken = await add("x.png", "x", "ornament");
    assertEquals(taken.status, 409);
    await taken.body?.cancel();
    const heic = await add("x.heic", "x");
    assertEquals(heic.status, 415);
    assertEquals(
      await heic.text(),
      "Only PNG, JPEG, WebP or SVG images can go in a book",
    );
    const nameless = await fetch(url, { method: "POST", body: "x" });
    assertEquals(nameless.status, 400);
    await nameless.body?.cancel();
    // A slug with a space or a dot round-trips the query and the image route.
    const spaced = await add("x.png", "sp", encodeURIComponent("Orchard 1943"));
    assertEquals(await spaced.json(), {
      slug: "Orchard 1943",
      name: "Orchard 1943.png",
    });
    const served = await fetch(
      `http://localhost:${server.port}/books/demo-book/images/${
        encodeURIComponent("Orchard 1943.png")
      }`,
    );
    assertEquals(await served.text(), "sp");
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});
