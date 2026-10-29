// web/src/book-zip.ts — a book's folder as one zip: what an author downloads
// from browser storage, shaped so unzipping gives `<book>/` with its files,
// which "Import a folder" and `deno task bml` both take back as-is.
import { zipSync } from "fflate";
import type { BookStore } from "../../server/store.ts";

/** The files a book has, relative to its folder: what a zip or a copy takes. */
export async function bookFiles(
  store: BookStore,
  book: string,
): Promise<string[]> {
  // Some may be missing; callers skip a null read. manuscript.md comes last:
  // copyBooks counts a book present by it, so it must land after the rest.
  const rels = ["metadata.json", "dictionary.json"];
  for (const dir of ["editions", "images"]) {
    for (const name of await store.listDir(`${book}/${dir}`)) {
      rels.push(`${dir}/${name}`);
    }
  }
  return [...rels, "manuscript.md"];
}

async function zipBooks(
  store: BookStore,
  books: string[],
  prefix: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const files: Record<string, Uint8Array> = {};
  for (const book of books) {
    for (const rel of await bookFiles(store, book)) {
      const data = await store.read(`${book}/${rel}`);
      if (data) files[`${prefix}${book}/${rel}`] = data;
    }
  }
  return new Uint8Array(zipSync(files)); // a plain ArrayBuffer, for Blob
}

export const zipBook = (
  store: BookStore,
  book: string,
): Promise<Uint8Array<ArrayBuffer>> => zipBooks(store, [book], "");

/** Every book under `Books/`, the folder "Import a folder" takes whole. */
export const zipLibrary = (
  store: BookStore,
  books: string[],
): Promise<Uint8Array<ArrayBuffer>> => zipBooks(store, books, "Books/");
