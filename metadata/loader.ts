import type { Metadata } from "./types.ts";
import { upgradePageSetup } from "./upgrade.ts";

export async function loadMetadata(path: string): Promise<Metadata | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  try {
    return upgradePageSetup(JSON.parse(text) as Metadata);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${e.message}`);
    }
    throw e;
  }
}
