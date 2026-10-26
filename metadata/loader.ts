import type { Metadata } from "./types.ts";
import { upgradeMetadata } from "./upgrade.ts";

/** The metadata file's parsed value and the exact text it was parsed from. */
async function loadMetadataText(
  path: string,
): Promise<{ meta: Metadata; text: string } | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  return parseMetadataText(text, path);
}

/** The file's text → its upgraded value; `path` only names it in the error. */
export function parseMetadataText(
  text: string,
  path: string,
): { meta: Metadata; text: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid metadata in ${path}: not a JSON object`);
  }
  return { meta: upgradeMetadata(value as Metadata), text };
}

export async function loadMetadata(path: string): Promise<Metadata | null> {
  return (await loadMetadataText(path))?.meta ?? null;
}
