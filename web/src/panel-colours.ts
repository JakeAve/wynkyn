// web/src/panel-colours.ts — the style panel's Colours view (spec §4.15,
// §7.5): one block per book colour (name → any CSS colour), each with
// swatches and "Used by" chips. Parts pick these by name in their Colour row,
// so changing one here recolours everything that uses it.
import { renameColour } from "./config-data.ts";
import { row, section, swatches } from "./panel-controls.ts";
import { type PanelContext, usedBy } from "./style-catalog.ts";

// `ink` is the body's text colour, which every part inherits.
const FIXED = ["ink"];

// Inks a binder reaches for; any colour can still be picked or typed.
const SUGGESTED = [
  { value: "#000000", label: "Black" },
  { value: "#3b3631", label: "Warm black" },
  { value: "#9e2a1e", label: "Rubric red" },
  { value: "#2a3f8f", label: "Ultramarine" },
  { value: "#5b4636", label: "Sepia" },
  { value: "#666666", label: "Grey" },
];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(...kids);
  if (e instanceof HTMLButtonElement) e.type = "button";
  return e;
};

export function buildColoursTab(ctx: PanelContext): Node[] {
  const { meta, queueSave } = ctx;
  const holder = document.createElement("div");

  function block(name: string): HTMLElement {
    const colors = meta.colors ??= {};
    const kids: Node[] = [];
    if (!FIXED.includes(name)) {
      const nameIn = el("input", "txt");
      nameIn.type = "text";
      nameIn.value = name;
      nameIn.setAttribute("aria-label", "Colour name");
      // On commit, not per keystroke; references follow the new name.
      nameIn.onchange = () => {
        const next = nameIn.value.trim();
        if (!next || next === name || Object.hasOwn(colors, next)) {
          nameIn.value = name; // blank or collision: keep the old name
          return;
        }
        renameColour(meta, name, next);
        for (const k of ["colors", "elements", "is", "numbering", "running"]) {
          queueSave(k as keyof typeof meta);
        }
        render();
      };
      kids.push(row("Name", nameIn, { set: true }));
    }
    // A new colour has no value yet; it is saved once one is picked.
    const ink = swatches(SUGGESTED, colors[name] || undefined, (v) => {
      if (!v) return; // a colour can't be unset, only removed
      colors[name] = v;
      queueSave("colors");
    }, `${name} colour`);
    ink.classList.add("ink");
    kids.push(row("Colour", ink, { set: true }));
    if (name === "ink") {
      kids.push(el(
        "p",
        "hint",
        "The text colour. Every part uses it unless it picks another colour.",
      ));
    }
    const uses = usedBy(meta, name, "color");
    kids.push(el(
      "div",
      "uses",
      el(
        "span",
        "from",
        uses.length ? "Used by" : "Nothing uses this colour yet.",
      ),
      ...uses.map((u) => {
        const chip = el("button", "chip", u.label);
        chip.onclick = () => ctx.go(u.route);
        return chip;
      }),
    ));
    if (!FIXED.includes(name)) {
      const rm = el("button", "tog", "Remove colour");
      rm.onclick = () => {
        delete colors[name];
        queueSave("colors");
        render();
      };
      kids.push(el("div", "", rm));
    }
    return section(name === "ink" ? "Ink" : name, name, kids);
  }

  function render(): void {
    const colors = meta.colors ??= {};
    const names = [
      ...FIXED,
      ...Object.keys(colors).filter((n) => !FIXED.includes(n)),
    ];
    const add = el("button", "tog", "Add a colour");
    add.onclick = () => {
      let name = "new-colour";
      for (let i = 2; Object.hasOwn(colors, name); i++) {
        name = `new-colour-${i}`;
      }
      colors[name] = ""; // not saved until a colour is chosen
      render();
    };
    holder.replaceChildren(
      ...names.map(block),
      section("More colours", "more-colours", [
        el(
          "p",
          "hint",
          "Add a colour, like a red for chapter numbers, then choose it in any book part.",
        ),
        el("div", "", add),
      ]),
    );
  }

  render();
  return [holder];
}
