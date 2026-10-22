// metadata/upgrade.ts — in-place schema upgrades applied on load, so a book
// written against an older shape keeps working without a migration step.
import type { Metadata } from "./types.ts";

/**
 * Folds the retired `print` section into `page` (§4.3). `page` wins on any key
 * present in both, so a file already migrated is untouched. Every file
 * converges on the new shape the first time the config panel saves it.
 */
export function upgradePageSetup(meta: Metadata): Metadata {
  const print = meta.print;
  if (!print || typeof print !== "object") return meta;
  const { print: _dropped, ...rest } = meta;
  const page = { ...rest.page };
  if (page.sheet === undefined && print["sheet-size"] !== undefined) {
    page.sheet = print["sheet-size"];
  }
  if (
    page["folios-per-signature"] === undefined &&
    print["folios-per-signature"] !== undefined
  ) {
    page["folios-per-signature"] = print["folios-per-signature"];
  }
  if (page.duplex === undefined && print.duplex !== undefined) {
    page.duplex = print.duplex;
  }
  return { ...rest, page };
}

/** The metadata/BML spec version this build writes and understands (§4.2). */
export const SPEC_VERSION = "0.6";

/** Every on-load upgrade, then the `spec` stamp for a file that has none. */
export function upgradeMetadata(meta: Metadata): Metadata {
  const upgraded = upgradePageSetup(meta);
  return upgraded.spec === undefined
    ? { spec: SPEC_VERSION, ...upgraded }
    : upgraded;
}

/** True when the file claims a spec this build does not know yet. */
export function isNewerSpec(spec: string | undefined): boolean {
  if (!spec) return false;
  const a = spec.split(".").map(Number);
  const b = SPEC_VERSION.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
