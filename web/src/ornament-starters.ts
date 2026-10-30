// Art a book can start from, for a binder with none of their own. Picking one
// copies it into the book's images/, so the book stays whole on its own. Drawn
// by us for the top-left corner in a 100-unit square: the renderer turns it.
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// Half of a corner; the other half is its reflection across the diagonal.
const both = (half: string) =>
  `${half}<g transform="matrix(0 1 1 0 0 0)">${half}</g>`;

const LEAF = "M0 0C3-4 9-5 14 0C9 5 3 4 0 0Z";
const leaf = (x: number, y: number, deg: number, scale = 1) =>
  `<path d="${LEAF}" fill="#000" stroke="none" transform="translate(${x} ${y}) rotate(${deg}) scale(${scale})"/>`;

export const STARTERS: { slug: string; name: string; svg: string }[] = [
  {
    slug: "corner-double-rule",
    name: "Double rule",
    svg: svg(
      both(
        `<path d="M6 6H94" stroke-width="2"/><path d="M13 13H74" stroke-width=".8"/><circle cx="94" cy="6" r="2.4" fill="#000" stroke="none"/><path d="M78 13l2.5-2.5 2.5 2.5-2.5 2.5Z" fill="#000" stroke="none"/>`,
      ) + `<path d="M13 13l6 0 0 6-6 0Z" fill="#000" stroke="none"/>`,
    ),
  },
  {
    slug: "corner-scroll",
    name: "Scroll",
    svg: svg(
      both(
        `<path d="M7 7C30 5 52 8 66 19C76 27 76 40 66 42C58 43 54 36 58 31C61 28 66 30 65 34" stroke-width="2"/><path d="M15 15C34 15 46 19 53 27" stroke-width=".9"/>`,
      ) + `<circle cx="7" cy="7" r="3" fill="#000" stroke="none"/>`,
    ),
  },
  {
    slug: "corner-vine",
    name: "Vine",
    svg: svg(
      both(
        `<path d="M8 8C30 4 58 8 90 6" stroke-width="1.6"/>${leaf(24, 7, 28)}${
          leaf(36, 7, -26, .9)
        }${leaf(50, 8, 26, .9)}${leaf(62, 8, -24, .8)}${leaf(76, 7, 22, .7)}${
          leaf(90, 6, -6, .6)
        }`,
      ) + `<circle cx="11" cy="11" r="3.4" fill="#000" stroke="none"/>`,
    ),
  },
  {
    slug: "corner-sprig",
    name: "Sprig",
    svg: svg(
      `<path d="M8 8C24 24 40 40 72 72" stroke-width="1.6"/>` +
        both(
          `${leaf(20, 20, -8)}${leaf(34, 34, -12, 1.2)}${leaf(50, 50, -14, 1)}${
            leaf(62, 62, -14, .8)
          }`,
        ) + leaf(72, 72, 45, .8),
    ),
  },
];
