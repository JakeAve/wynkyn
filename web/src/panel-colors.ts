// web/src/panel-colors.ts — the style panel's Colors view (spec §4.15,
// §7.5): one block per book color (name → any CSS color), each with one
// picker showing the color and "Used by" chips. Parts pick these by name in their Color row,
// so changing one here recolors everything that uses it.
import { renameColor } from "./config-data.ts";
import { row, section } from "./panel-controls.ts";
import { type PanelContext, usedBy } from "./style-catalog.ts";

// `ink` is the body's text color, which every part inherits.
const FIXED = ["ink"];

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

export function buildColorsTab(ctx: PanelContext): Node[] {
  const { meta, queueSave } = ctx;
  const holder = document.createElement("div");

  function block(name: string): HTMLElement {
    const colors = meta.colors ??= {};
    const kids: Node[] = [];
    if (!FIXED.includes(name)) {
      const nameIn = el("input", "txt");
      nameIn.type = "text";
      nameIn.value = name;
      nameIn.setAttribute("aria-label", "Color name");
      // On commit, not per keystroke; references follow the new name.
      nameIn.onchange = () => {
        const next = nameIn.value.trim();
        if (!next || next === name || Object.hasOwn(colors, next)) {
          nameIn.value = name; // blank or collision: keep the old name
          return;
        }
        renameColor(meta, name, next);
        for (const k of ["colors", "elements", "is", "numbering", "running"]) {
          queueSave(k as keyof typeof meta);
        }
        render();
      };
      kids.push(row("Name", nameIn, { set: true }));
    }
    // A new color has no value yet; it is saved once one is picked.
    const pick = el("input", "color-pick");
    pick.type = "color";
    pick.value = colors[name] || "#000000";
    pick.setAttribute("aria-label", `${name} color`);
    pick.onchange = () => { // on release: one save, not one per drag tick
      colors[name] = pick.value;
      queueSave("colors");
    };
    kids.push(row("Color", pick, { set: true }));
    if (name === "ink") {
      kids.push(el(
        "p",
        "hint",
        "Default color for all text",
      ));
    }
    const uses = usedBy(meta, name, "color");
    kids.push(el(
      "div",
      "uses",
      el(
        "span",
        "from",
        uses.length ? "Used by" : "Nothing uses this color yet.",
      ),
      ...uses.map((u) => {
        const chip = el("button", "chip", u.label);
        chip.onclick = () => ctx.go(u.route);
        return chip;
      }),
    ));
    if (!FIXED.includes(name)) {
      const rm = el("button", "tog", "Remove color");
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
    const add = el("button", "tog", "Add a color");
    add.onclick = () => {
      let name = "new-color";
      for (let i = 2; Object.hasOwn(colors, name); i++) {
        name = `new-color-${i}`;
      }
      colors[name] = ""; // not saved until a color is chosen
      render();
    };
    holder.replaceChildren(
      ...names.map(block),
      section("More colors", "more-colors", [
        el(
          "p",
          "hint",
          "Add a new color that can be used throughout the book",
        ),
        el("div", "", add),
      ]),
    );
  }

  render();
  return [holder];
}
