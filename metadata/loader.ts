import type { Metadata } from "./types.ts";
import { upgradePageSetup } from "./upgrade.ts";

/** The metadata file's parsed value and the exact text it was parsed from. */
export async function loadMetadataText(
  path: string,
): Promise<{ meta: Metadata; text: string } | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  try {
    return { meta: upgradePageSetup(JSON.parse(text) as Metadata), text };
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${e.message}`);
    }
    throw e;
  }
}

export async function loadMetadata(path: string): Promise<Metadata | null> {
  return (await loadMetadataText(path))?.meta ?? null;
}
