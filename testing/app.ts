// The app for Chrome tests: one dev server per test process over a library in
// memory. A test seeds its own book under a fresh slug rather than copying a
// folder and booting a server, and an outside edit is a store write the
// server hears at once, with no FSEvents to arrive late or twice. Only
// server/live-sync-browser_test.ts is about the disk, and keeps it.
import { type Page } from "playwright";
import { startServer } from "../server/dev-server.ts";
import type { Metadata } from "../metadata/types.ts";
import { memoryStore } from "./memory-store.ts";
import { chromeTest, newPage } from "./chrome.ts";
import { laidOut } from "./wait.ts";

export const appBuilt = await Deno.stat(
  new URL("../web/app.js", import.meta.url),
)
  .then(() => true, () => false);

/** A Chrome test of the app; skipped until `deno task build:web`. */
export const appTest = (
  t: Parameters<typeof chromeTest>[0],
) => chromeTest({ ...t, ignore: !appBuilt || t.ignore });

const DEMO = new URL("../server/testdata/demo-book/", import.meta.url);
const files = new Map<string, Uint8Array>();
const store = memoryStore(files);
let server: ReturnType<typeof startServer> | undefined;
let seq = 0;

async function* demoFiles(dir = DEMO, rel = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const name = rel + e.name;
    if (e.isDirectory) {
      yield* demoFiles(new URL(`${e.name}/`, dir), `${name}/`);
    } else yield name;
  }
}

export interface TestBook {
  slug: string;
  /** The app on this book, plus any extra query (`&mode=style`). */
  url(query?: string): string;
  /** A file in the book, as the server sees it. */
  read(name: string): Promise<string | null>;
  /** An outside edit: the server pushes it as it would a disk change. */
  write(name: string, data: string | Uint8Array): Promise<void>;
}

/** The demo book (server/testdata/demo-book) under a fresh slug, its
 * manuscript and metadata changed first if asked. */
export async function book(opts: {
  manuscript?: string | ((demo: string) => string);
  metadata?: (meta: Metadata) => void;
} = {}): Promise<TestBook> {
  const slug = `book-${++seq}`;
  for await (const name of demoFiles()) {
    files.set(`${slug}/${name}`, await Deno.readFile(new URL(name, DEMO)));
  }
  const text = async (name: string) => await store.readText(`${slug}/${name}`);
  const { manuscript, metadata } = opts;
  if (manuscript !== undefined) {
    const next = typeof manuscript === "string"
      ? manuscript
      : manuscript((await text("manuscript.md"))!);
    await store.write(`${slug}/manuscript.md`, next);
  }
  if (metadata) {
    const meta = JSON.parse((await text("metadata.json"))!);
    metadata(meta);
    await store.write(`${slug}/metadata.json`, JSON.stringify(meta));
  }
  const { port } = await (server ??= startServer({ store, port: 0 }));
  return {
    slug,
    url: (query = "") => `http://localhost:${port}/app/?book=${slug}${query}`,
    read: text,
    write: async (name, data) => {
      if (!await store.create(`${slug}/${name}`, data)) {
        await store.write(`${slug}/${name}`, data);
      }
    },
  };
}

/** A new page on the book's app, laid out. */
export async function openApp(b: TestBook, query = ""): Promise<Page> {
  const page = await newPage();
  await page.goto(b.url(query));
  await laidOut(page);
  return page;
}
