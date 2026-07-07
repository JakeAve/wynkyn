import type { Metadata } from "./types.ts";

export async function loadMetadata(bookDir: string): Promise<Metadata | null> {
  const path = `${bookDir}/metadata.json`;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  try {
    return JSON.parse(text) as Metadata;
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}
