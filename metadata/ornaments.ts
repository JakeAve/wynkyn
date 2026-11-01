// Page ornaments (spec §4.17): how art turns from the spot it was drawn for to
// the spot it sits in. Pure; the renderer and the panel's little page share it.
import type { OrnamentPlacement, OrnamentSpot } from "./types.ts";

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
