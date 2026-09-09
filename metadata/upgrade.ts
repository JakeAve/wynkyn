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
