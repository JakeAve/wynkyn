// server/import/mod.ts — one call from a file to a manuscript (spec §7.9).
// Runtime-agnostic: bytes in, BML and image files out, so the CLI and the
// browser app share it.
import type { Source } from "./blocks.ts";
import { readEpub } from "./epub.ts";
import { readHtml } from "./html.ts";
import { readText } from "./text.ts";
import { type ImportOptions, type Outline, structure } from "./structure.ts";
import { emit } from "./emit.ts";

export type { ImportOptions, Outline, Reading } from "./structure.ts";

export interface ImportResult {
  manuscript: string;
  images: Record<string, Uint8Array>; // images/<file> → bytes
  title: string;
  outline: Outline;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** The file as a block stream, by its contents first and its name second. */
export function readSource(name: string, bytes: Uint8Array): Source {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readEpub(name, bytes);
  const text = decoder.decode(bytes);
  const head = text.slice(0, 2000).trimStart().toLowerCase();
  if (
    /\.(x?html?)$/i.test(name) || head.startsWith("<!doctype html") ||
    head.startsWith("<html") || head.startsWith("<?xml")
  ) {
    const { title, blocks } = readHtml(text);
    return { name, title, tocTitles: [], blocks, images: {} };
  }
  return readText(name, text);
}

export function importSource(
  name: string,
  bytes: Uint8Array,
  opts: ImportOptions = {},
): ImportResult {
  const src = readSource(name, bytes);
  const outline = structure(src, opts);
  const { manuscript, images } = emit(outline);
  return {
    manuscript,
    images,
    title: src.title ?? name.replace(/\.[^.]+$/, ""),
    outline,
  };
}
