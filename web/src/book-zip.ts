// web/src/book-zip.ts — a book's folder as one zip: what an author downloads
// from browser storage, shaped so unzipping gives `<book>/` with its files,
// which "Import a folder" and `deno task bml` both take back as-is.
import { zipSync } from "fflate";
import type { BookStore } from "../../server/store.ts";

export async function zipBook(
  store: BookStore,
  book: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const files: Record<string, Uint8Array> = {};
  const add = async (rel: string) => {
    const data = await store.read(`${book}/${rel}`);
    if (data) files[`${book}/${rel}`] = data;
  };
  await add("manuscript.md");
  await add("metadata.json");
  for (const dir of ["editions", "images"]) {
    for (const name of await store.listDir(`${book}/${dir}`)) {
      await add(`${dir}/${name}`);
    }
  }
  return new Uint8Array(zipSync(files)); // a plain ArrayBuffer, for Blob
}
