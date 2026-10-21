// server/dev-server_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { startServer } from "./dev-server.ts";

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
    const shell = await fetch(`${base}/`);
    assertEquals(shell.status, 200);
    assert((await shell.text()).includes('id="preview"'));

    const books = await (await fetch(`${base}/api/books`)).json();
    assertEquals(books, { books: ["demo-book"] });

    const build = await (await fetch(`${base}/api/books/demo-book`)).json();
    assert(build.html.includes("Chapter One"));
    assert(build.pagedCss.includes("@page"));

    const img = await fetch(`${base}/books/demo-book/images/ornament.svg`);
    assertEquals(img.status, 200);
    assertEquals(img.headers.get("content-type"), "image/svg+xml");
    await img.body?.cancel();

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
    assertEquals(first.origin, null);
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
    assertEquals(msg.origin, null);
    assert((msg.html as string).includes("Chapter Won"));
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("save: rapid posts coalesce to one write, broadcast tagged with origin", async () => {
  const root = await makeBooksRoot();
  // Debounce long enough that two sequential local fetches land inside one window.
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 200,
  });
  const base = `http://localhost:${server.port}`;
  const ws = new WebSocket(
    `ws://localhost:${server.port}/ws?book=demo-book&client=observer`,
  );
  try {
    await nextMessage(ws); // initial build
    await new Promise((r) => setTimeout(r, 300)); // let the watch warm up
    const pushed = nextMessage(ws);

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
    await r1.body?.cancel();
    const r2 = await post(draftB);
    assertEquals(r2.status, 200);
    await r2.body?.cancel();

    const msg = await pushed;
    assertEquals(msg.type, "update");
    assertEquals(msg.origin, "editor-1"); // spec §6: originating editor can ignore this
    assert((msg.html as string).includes("Draft B"));
    // Only the LAST text hit the disk — the debounce swallowed Draft A.
    assertEquals(
      await Deno.readTextFile(`${root}/demo-book/manuscript.md`),
      draftB,
    );

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

Deno.test("save: failed debounced write doesn't leak a stale recentWrites entry", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 150,
  });
  const base = `http://localhost:${server.port}`;
  try {
    // Accepted synchronously, but the actual write happens after the debounce.
    const post = await fetch(`${base}/api/books/demo-book/manuscript`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "won't land", clientId: "editor-1" }),
    });
    assertEquals(post.status, 200);
    await post.body?.cancel();

    // Yank the book out from under the pending write before the debounce
    // timer fires, forcing Deno.writeTextFile to reject (ENOENT). This must
    // not crash the server, and must not leave "editor-1" sitting in
    // recentWrites for demo-book forever.
    await Deno.remove(`${root}/demo-book`, { recursive: true });
    await new Promise((r) => setTimeout(r, 400)); // let the debounced write fail

    // Server must still be alive and serving other requests.
    const books = await (await fetch(`${base}/api/books`)).json();
    assertEquals(books, { books: [] });

    // Recreate the book out-of-band (not via the save API) and let an
    // unrelated, later change to manuscript.md broadcast normally.
    await Deno.mkdir(`${root}/demo-book/images`, { recursive: true });
    const src = new URL("./testdata/demo-book/", import.meta.url);
    for (const f of ["manuscript.md", "metadata.json"]) {
      await Deno.copyFile(new URL(f, src), `${root}/demo-book/${f}`);
    }
    await Deno.copyFile(
      new URL("images/ornament.svg", src),
      `${root}/demo-book/images/ornament.svg`,
    );
    await new Promise((r) => setTimeout(r, 500)); // let the watcher settle after recreation

    const ws = new WebSocket(
      `ws://localhost:${server.port}/ws?book=demo-book&client=observer`,
    );
    try {
      const first = await nextMessage(ws);
      assertEquals(first.type, "update");

      const pushed = nextMessage(ws);
      const manuscript = `${root}/demo-book/manuscript.md`;
      const text = await Deno.readTextFile(manuscript);
      await Deno.writeTextFile(
        manuscript,
        text.replace("Chapter One", "Chapter Won"),
      );

      const msg = await pushed;
      assertEquals(msg.type, "update");
      // If the failed save's clientId had leaked in recentWrites, this
      // unrelated change would incorrectly be tagged "editor-1".
      assertEquals(msg.origin, null);
    } finally {
      ws.close();
    }
  } finally {
    await server.stop();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("http: GET manuscript returns source; pending saves read through", async () => {
  const root = await makeBooksRoot();
  // 5s debounce: the POSTed save is guaranteed still pending when we GET.
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 5000,
  });
  const base = `http://localhost:${server.port}`;
  try {
    const res = await fetch(`${base}/api/books/demo-book/manuscript`);
    assertEquals(res.status, 200);
    const { text } = await res.json();
    assert(text.includes("{chapter: one}"));

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
    const { metadata } = await res.json();
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
    assertEquals((await post.json()).ok, true);

    // Pending save reads through before the debounce flushes.
    const during = await (await fetch(`${base}/api/books/demo-book/metadata`))
      .json();
    assertEquals(during.metadata.page.size, "A5");

    await new Promise((r) => setTimeout(r, 150));
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
    assertEquals(empty.metadata, {});

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

Deno.test("metadata: debounced write broadcasts an update tagged with origin", async () => {
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
    assertEquals((await post.json()).ok, true);

    const msg = await pushed;
    assertEquals(msg.type, "update");
    assertEquals(msg.origin, "cfg-1"); // spec §6: originator can ignore the echo
    assert((msg.pagedCss as string).includes("float: footnote"));
  } finally {
    ws.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
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
          summary: "5.5in × 8.5in · 2-up on letter · EB Garamond · 11pt",
        },
        { slug: "pocket", summary: "3.5in 5in · Crimson Pro · 9pt" },
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
    const p1 = nextMessageWhere(pocket, (m) => m.origin === "p");
    await post(`${base}/api/books/demo-book/editions/pocket/metadata`, {
      sections: { notes: { placement: "footnote" } },
      clientId: "p",
    });
    const msg = await p1;
    assertEquals(msg.origin, "p");
    assertEquals(msg.edition, "pocket");
    assert((msg.pagedCss as string).includes("float: footnote"));
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(unnamedHeard, false);

    // Manuscript write → both clients, each built with its own edition.
    const u2 = nextMessageWhere(unnamed, (m) => m.origin === "u");
    const p2 = nextMessageWhere(pocket, (m) => m.origin === "u");
    await post(`${base}/api/books/demo-book/manuscript`, {
      text: "{matter: half-title}\n{title}\nRenamed\n",
      clientId: "u",
    });
    const [um, pm] = await Promise.all([u2, p2]);
    assertEquals(um.origin, "u");
    assertEquals(pm.origin, "u");
    assert((um.pagedCss as string).includes("5.5in 8.5in"));
    assert((pm.pagedCss as string).includes("3.5in 5in"));
  } finally {
    unnamed.close();
    pocket.close();
    await server.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("http: print export lands a pending save, lists the PDFs and serves them; problems need force", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const root = await makeBooksRoot();
  let problems = [{ page: 2, message: "stranded page: no text or image" }];
  const render = async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([396, 612]).drawText(String(i + 1));
    return { pdf: await doc.save(), problems, passes: 1, seed: {} };
  };
  const server = await startServer({
    booksRoot: root,
    port: 0,
    saveDebounceMs: 60_000, // only the export can land this save
    render,
  });
  const base = `http://localhost:${server.port}/api/books/demo-book`;
  const post = (body: unknown) =>
    fetch(`${base}/export`, { method: "POST", body: JSON.stringify(body) });
  try {
    await (await fetch(`${base}/metadata`, {
      method: "POST",
      body: JSON.stringify({ sections: { page: { duplex: "none" } } }),
    })).text();

    const refused = await post({});
    assertEquals(refused.status, 409);
    assertEquals((await refused.json()).problems, [
      "page 2: stranded page: no text or image",
    ]);
    const saved = JSON.parse(
      await Deno.readTextFile(`${root}/demo-book/metadata.json`),
    );
    assertEquals(saved.page, { duplex: "none" });

    const forced = await post({ force: true });
    assertEquals(forced.status, 200);
    const json = await forced.json();
    assertEquals(json.files, [
      "book.pdf",
      "sheets-fronts.pdf",
      "sheets-backs.pdf",
    ]);
    assertEquals(json.problems.length, 1);

    problems = [];
    assertEquals((await post({})).status, 200);
    const pdf = await fetch(`${base}/export/sheets-backs.pdf`);
    assertEquals(pdf.headers.get("content-type"), "application/pdf");
    await pdf.body?.cancel();
    const missing = await fetch(`${base}/export/nope.pdf?edition=pocket`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await server.stop();
  }
});
