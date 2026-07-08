// server/dev-server_test.ts
import { assert, assertEquals } from "jsr:@std/assert";
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

Deno.test("websocket: initial build on connect, rebuild pushed on file change", async () => {
  const root = await makeBooksRoot();
  const server = await startServer({ booksRoot: root, port: 0 });
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?book=demo-book&client=t1`);
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
    await Deno.writeTextFile(manuscript, src.replace("Chapter One", "Chapter Won"));

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
  const server = await startServer({ booksRoot: root, port: 0, saveDebounceMs: 200 });
  const base = `http://localhost:${server.port}`;
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?book=demo-book&client=observer`);
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
    assertEquals(await Deno.readTextFile(`${root}/demo-book/manuscript.md`), draftB);

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
  const server = await startServer({ booksRoot: root, port: 0, saveDebounceMs: 150 });
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

    const ws = new WebSocket(`ws://localhost:${server.port}/ws?book=demo-book&client=observer`);
    try {
      const first = await nextMessage(ws);
      assertEquals(first.type, "update");

      const pushed = nextMessage(ws);
      const manuscript = `${root}/demo-book/manuscript.md`;
      const text = await Deno.readTextFile(manuscript);
      await Deno.writeTextFile(manuscript, text.replace("Chapter One", "Chapter Won"));

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
  const server = await startServer({ booksRoot: root, port: 0, saveDebounceMs: 5000 });
  const base = `http://localhost:${server.port}`;
  try {
    const res = await fetch(`${base}/api/books/demo-book/manuscript`);
    assertEquals(res.status, 200);
    const { text } = await res.json();
    assert(text.includes("{chapter: one}"));

    const post = await fetch(`${base}/api/books/demo-book/manuscript`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "{chapter: two}\nNew text.", clientId: "t1" }),
    });
    assertEquals((await post.json()).ok, true);
    const after = await (await fetch(`${base}/api/books/demo-book/manuscript`)).json();
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
  const server = await startServer({ booksRoot: root, port: 0, saveDebounceMs: 40 });
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
      body: JSON.stringify({ sections: { page: { size: "A5" } }, clientId: "t1" }),
    });
    assertEquals((await post.json()).ok, true);

    // Pending save reads through before the debounce flushes.
    const during = await (await fetch(`${base}/api/books/demo-book/metadata`)).json();
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
  const server = await startServer({ booksRoot: root, port: 0, saveDebounceMs: 40 });
  const base = `http://localhost:${server.port}`;
  try {
    const empty = await (await fetch(`${base}/api/books/demo-book/metadata`)).json();
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
  const server = await startServer({ booksRoot: root, port: 0, saveDebounceMs: 40 });
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?book=demo-book&client=cfg-1`);
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
