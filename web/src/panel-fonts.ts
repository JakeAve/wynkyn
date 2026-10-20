// web/src/panel-fonts.ts — the style panel's Fonts tab (spec R1): the
// `fonts` section's alias → Google Fonts family map.
import { renameKey } from "./config-data.ts";
import { textInput } from "./config-panel.ts";
import { GOOGLE_FONTS } from "./fonts-list.ts";
import { section } from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";

export function buildFontsTab(ctx: PanelContext): Node[] {
  const { meta, queueSave } = ctx;
  const dl = document.createElement("datalist");
  dl.id = "google-fonts-list";
  for (const f of GOOGLE_FONTS) dl.appendChild(new Option(f, f));
  const rows = document.createElement("div");
  const add = document.createElement("button");
  add.textContent = "+ font alias";

  function render(): void {
    rows.innerHTML = "";
    const fonts = meta.fonts ??= {};
    for (const alias of Object.keys(fonts)) {
      const aliasIn = document.createElement("input");
      aliasIn.type = "text";
      aliasIn.value = alias;
      aliasIn.placeholder = "alias";
      aliasIn.setAttribute("aria-label", "font alias");
      // Rename on commit (change = blur/enter), not per keystroke — a
      // half-typed alias must not repeatedly rename the key.
      aliasIn.onchange = () => {
        const next = aliasIn.value.trim();
        if (!next || next === alias) {
          aliasIn.value = alias;
          return;
        }
        if (Object.hasOwn(fonts, next)) {
          aliasIn.value = alias; // collision: refuse silently, keep old name
          return;
        }
        meta.fonts = renameKey(fonts, alias, next);
        queueSave("fonts");
        render();
      };
      const familyIn = textInput(fonts[alias] ?? "", (v) => {
        fonts[alias] = v;
        // Empty family would put a blank entry in the css2 URL — save once
        // there's a real value; deletion is the ✕ button's job.
        if (v) queueSave("fonts");
      });
      familyIn.setAttribute("list", "google-fonts-list");
      familyIn.placeholder = "Google Fonts family";
      familyIn.setAttribute("aria-label", "font family");
      const rm = document.createElement("button");
      rm.textContent = "✕";
      rm.title = `remove ${alias}`;
      rm.onclick = () => {
        delete fonts[alias];
        queueSave("fonts");
        render();
      };
      const row = document.createElement("div");
      row.className = "cfg-field";
      row.append(aliasIn, familyIn, rm);
      rows.appendChild(row);
    }
  }

  add.onclick = () => {
    const fonts = meta.fonts ??= {};
    let alias = "new-font";
    for (let i = 2; Object.hasOwn(fonts, alias); i++) alias = `new-font-${i}`;
    fonts[alias] = "";
    render(); // not saved until a family name is typed (see familyIn)
  };

  render();
  return [section("Fonts", "fonts", [dl, rows, add])];
}
