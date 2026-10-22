// server/local-fonts.ts — fonts installed on this machine (spec §4.4). A
// `fonts` value that isn't a Google family is an installed font, which Chrome
// finds by family name; these say which ones it will find. Read fresh on every
// call (about 0.1s), so a font installed mid-session shows up.
import type { Metadata } from "../metadata/types.ts";
import { GOOGLE_FAMILIES } from "../metadata/fonts-catalog.ts";

// NSFontManager's family names are the ones Chrome on macOS matches a CSS
// font-family against. Names starting with "." are hidden system faces.
const LIST = `ObjC.import("AppKit");
JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))`;

// ponytail: macOS only (empty elsewhere, so every non-Google family warns);
// `fc-list : family` would cover Linux.
export async function installedFonts(): Promise<string[]> {
  if (Deno.build.os !== "darwin") return [];
  try {
    const out = await new Deno.Command("osascript", {
      args: ["-l", "JavaScript", "-e", LIST],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return [];
    const names = JSON.parse(new TextDecoder().decode(out.stdout)) as string[];
    return names.filter((f) => !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** The book's families that are neither Google families nor installed. */
export async function missingFonts(meta: Metadata): Promise<string[]> {
  const families = [...new Set(Object.values(meta.fonts ?? {}))]
    .filter((f) => f && !GOOGLE_FAMILIES.has(f));
  if (!families.length) return []; // skip the lookup for all-Google books
  const installed = new Set(await installedFonts());
  return families.filter((f) => !installed.has(f));
}
