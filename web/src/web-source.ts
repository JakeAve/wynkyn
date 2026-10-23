// web/src/web-source.ts — a web page as an import source: fetched by address,
// or pasted from the clipboard, into the `{ name, bytes, from }` import takes.
import { gutenbergNumber } from "../../server/import/blocks.ts";

export interface WebSource {
  name: string;
  bytes: Uint8Array;
  from: string;
}

export async function fetchSource(url: string): Promise<WebSource> {
  const res = await fetch(url); // a TypeError here means blocked (CORS, offline)
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }
  return {
    name: fileName(url),
    bytes: new Uint8Array(await res.arrayBuffer()),
    from: url,
  };
}

/** The clipboard's HTML when it has paragraphs or headings; else its text
 *  (Chrome copies a plain-text page as one `<pre>`, which would read as verse). */
export function pasteSource(
  data: { getData(type: string): string },
  from: string,
): WebSource | null {
  const host = URL.canParse(from) ? new URL(from).host : "pasted";
  const html = data.getData("text/html");
  const [name, text] = /<(p|h[1-6])[\s>]/i.test(html)
    ? [`${host}.html`, `<!doctype html>\n${html}`]
    : [`${host}.txt`, data.getData("text/plain")];
  if (!text) return null;
  return { name, bytes: new TextEncoder().encode(text), from };
}

/** A Gutenberg book page or download → its plain-text file, whose select-all
 *  copy keeps the header lines; any other address as is. */
export function openUrl(url: string): string {
  const n = gutenbergNumber(url);
  return n ? `https://www.gutenberg.org/cache/epub/${n}/pg${n}.txt` : url;
}

/** The address's last path segment when it has an extension, else `<host>.html`. */
export function fileName(url: string): string {
  const { host, pathname } = new URL(url);
  const last = decodeURIComponent(pathname.split("/").pop() ?? "");
  return /\.\w+$/.test(last) ? last : `${host}.html`;
}
