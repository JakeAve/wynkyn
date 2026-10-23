import { assertEquals, assertRejects } from "@std/assert";
import { fetchSource, fileName, openUrl, pasteSource } from "./web-source.ts";

const clip = (flavours: Record<string, string>) => ({
  getData: (type: string) => flavours[type] ?? "",
});
const text = (b: Uint8Array) => new TextDecoder().decode(b);

Deno.test("pasteSource: HTML with paragraphs, marked as a document", () => {
  const s = pasteSource(
    clip({ "text/html": "<H2>One</H2><p>Text.</p>", "text/plain": "One" }),
    "https://example.com/book",
  );
  assertEquals(s?.name, "example.com.html");
  assertEquals(text(s!.bytes), "<!doctype html>\n<H2>One</H2><p>Text.</p>");
  assertEquals(s?.from, "https://example.com/book");
});

Deno.test("pasteSource: a <pre>-only fragment falls back to the text", () => {
  const s = pasteSource(
    clip({
      "text/html": "<pre>Line one\nLine two</pre>",
      "text/plain": "Line one\nLine two",
    }),
    null,
  );
  assertEquals(s?.name, "pasted.txt");
  assertEquals(text(s!.bytes), "Line one\nLine two");
});

Deno.test("pasteSource: null when both flavours are empty", () => {
  assertEquals(pasteSource(clip({}), null), null);
});

Deno.test("openUrl: Gutenberg pages map to the plain-text file", () => {
  const txt = "https://www.gutenberg.org/cache/epub/1342/pg1342.txt";
  assertEquals(openUrl("https://www.gutenberg.org/ebooks/1342"), txt);
  assertEquals(openUrl("https://gutenberg.org/ebooks/1342.txt.utf-8"), txt);
  assertEquals(
    openUrl("https://www.gutenberg.org/cache/epub/1342/pg1342-images.html"),
    txt,
  );
  assertEquals(
    openUrl("https://example.com/ebooks/1342"),
    "https://example.com/ebooks/1342",
  );
});

Deno.test("fileName: last segment with an extension, else <host>.html", () => {
  assertEquals(fileName("https://example.com/a/book.txt"), "book.txt");
  assertEquals(fileName("https://example.com/a/book"), "example.com.html");
  assertEquals(fileName("https://example.com/"), "example.com.html");
});

Deno.test("fetchSource: the bytes, name and address; throws on 404", async () => {
  const server = Deno.serve(
    { port: 0, onListen() {} },
    (req) =>
      new URL(req.url).pathname === "/book.txt"
        ? new Response("Call me Ishmael.")
        : new Response("gone", { status: 404 }),
  );
  const base = `http://localhost:${server.addr.port}`;
  try {
    const s = await fetchSource(`${base}/book.txt`);
    assertEquals(text(s.bytes), "Call me Ishmael.");
    assertEquals(s.name, "book.txt");
    assertEquals(s.from, `${base}/book.txt`);
    await assertRejects(() => fetchSource(`${base}/missing`), Error, "404");
  } finally {
    await server.shutdown();
  }
});
