// Page ornaments (spec §4.17): how art turns from the spot it was drawn for to
// the spot it sits in. Pure; the pipeline and the panel's little page share it.
import type { Metadata, OrnamentPlacement, OrnamentSpot } from "./types.ts";

export const CORNERS: OrnamentSpot[] = [
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
];
export const EDGES: OrnamentSpot[] = ["top", "right", "bottom", "left"];

const ringOf = (spot: OrnamentSpot) => CORNERS.includes(spot) ? CORNERS : EDGES;

// A square turns cleanly only within its ring; a corner's art on an edge starts
// from the ring's first spot.
export function drawnFor(
  o: OrnamentPlacement,
  spot: OrnamentSpot,
): OrnamentSpot {
  const ring = ringOf(spot);
  const from = o["drawn-for"];
  return from && ring.includes(from) ? from : ring[0]!;
}

export function turnsTo(o: OrnamentPlacement, spot: OrnamentSpot): number {
  const ring = ringOf(spot);
  return (ring.indexOf(spot) - ring.indexOf(drawnFor(o, spot)) + 4) % 4;
}

// CSS object-position: art narrower than its square hugs the edge it was drawn
// against, so it hugs the page's edge once turned.
export function hug(from: OrnamentSpot): string {
  const [y, x] = from.split("-");
  if (x) return `${x} ${y}`;
  return y === "top" || y === "bottom" ? `center ${y}` : `${y} center`;
}

/** One thing set on a page, defaults filled in. An image by its file name:
 * its URL is the session's, and this travels in the preview cache. */
export interface OrnamentItem {
  kind: "art" | "rule" | "frame";
  type: string;
  inset: string;
  pages: "first" | "all";
  slug?: string;
  file?: string;
  spot?: OrnamentSpot;
  hug?: string;
  turns?: number;
  size?: string;
  style?: string;
  width?: string;
}

export type PageOrnaments = Record<string, OrnamentItem[]>;

/** `ornaments` as the page map sets them: applied at assembly, like folios, so
 * an edit lays nothing out. `files`: slug → file name; art with none sets
 * nothing. */
export function pageOrnaments(
  ornaments: Metadata["ornaments"],
  files: Record<string, string>,
): PageOrnaments {
  const out: PageOrnaments = {};
  for (const [type, list] of Object.entries(ornaments ?? {})) {
    const items = list.flatMap((o): OrnamentItem[] => {
      const inset = o.inset ?? "6mm";
      // A part's section holds its chapters, so "all" would mean the whole part.
      const pages = type === "part" ? "first" : o.pages ?? "first";
      if (o.kind === "rule") {
        const style = o.style ?? "single";
        const width = o.width ?? "0.75pt";
        return [{ kind: "rule", type, style, width, inset, pages }];
      }
      const slug = o.image;
      const file = slug ? files[slug] : undefined;
      if (!file) return [];
      if (o.kind === "frame") {
        return [{ kind: "frame", type, slug, file, inset, pages }];
      }
      return (o.at ?? []).map((spot) => ({
        kind: "art",
        type,
        slug,
        file,
        spot,
        hug: hug(drawnFor(o, spot)),
        turns: turnsTo(o, spot),
        size: o.size ?? "25mm",
        inset,
        pages,
      }));
    });
    if (items.length) out[type] = items;
  }
  return out;
}
