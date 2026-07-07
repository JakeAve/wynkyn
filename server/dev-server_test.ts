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
