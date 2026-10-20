// web/src/panel-fonts.ts — the style panel's Fonts tab (spec R1): one block
// per alias in the `fonts` section (alias → Google Fonts family), each with a
// typeface picker, a sample set in that font and "Used by" chips.
import { renameKey } from "./config-data.ts";
import { GOOGLE_FONTS } from "./fonts-list.ts";
import { row, section, select } from "./panel-controls.ts";
import { bookParts, type PanelContext, usedBy } from "./style-catalog.ts";

const SAMPLES: Record<string, string> = {
  body: "The quick brown fox jumps over the lazy dog.",
  display: "A Chapter Title",
};
const FIXED = ["body", "display"];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(...kids);
  return e;
};

export function buildFontsTab(ctx: PanelContext): Node[] {
  const { meta, queueSave } = ctx;
  const holder = document.createElement("div");
  // Parts on no page of this book drop out of "Used by". Body text always
  // stays; before the preview has paginated (every count 0) nothing drops.
  const counts = bookParts(meta).map((p) =>
    [p.id, Math.max(0, ...p.keys.map((k) => ctx.preview.pagesFor(k)))] as const
  );
  const absent = new Set(
    counts.some(([, n]) => n > 0)
      ? counts.filter(([id, n]) => n === 0 && id !== "body").map(([id]) => id)
      : [],
  );

  function picker(alias: string, sample: HTMLElement): HTMLSelectElement {
    const fonts = meta.fonts ??= {};
    const cur = fonts[alias] ?? "";
    const names: string[] = [...GOOGLE_FONTS];
    if (cur && !names.includes(cur)) names.unshift(cur); // a family we don't list
    const opts = names.map((f) => ({ label: f, value: f }));
    // A new alias has no family yet; an empty family would put a blank entry
    // in the css2 URL, so it is only saved once a real one is chosen.
    if (!cur) opts.unshift({ label: "Choose a typeface", value: "" });
    return select(opts, cur, (v) => {
      fonts[alias] = v;
      sample.style.fontFamily = v ? `"${v}", serif` : "";
      if (v) queueSave("fonts");
    }, `${alias} font`);
  }

  function block(alias: string): HTMLElement {
    const fonts = meta.fonts ??= {};
    const sample = el(
      "p",
      "sample",
      SAMPLES[alias] ?? "The quick brown fox jumps over the lazy dog.",
    );
    const fam = fonts[alias];
    if (fam) sample.style.fontFamily = `"${fam}", serif`;
    const kids: Node[] = [];

    if (!FIXED.includes(alias)) {
      const nameIn = document.createElement("input");
      nameIn.type = "text";
      nameIn.className = "txt";
      nameIn.value = alias;
      nameIn.setAttribute("aria-label", "Font name");
      // Rename on commit (change = blur/enter), not per keystroke — a
      // half-typed alias must not repeatedly rename the key.
      nameIn.onchange = () => {
        const next = nameIn.value.trim();
        if (!next || next === alias || Object.hasOwn(fonts, next)) {
          nameIn.value = alias; // blank or collision: keep the old name
          return;
        }
        meta.fonts = renameKey(fonts, alias, next);
        queueSave("fonts");
        render();
      };
      kids.push(row("Name", nameIn, { set: true }));
    }
    kids.push(row("Typeface", picker(alias, sample), { set: true }), sample);

    const uses = usedBy(meta, alias).filter((u) =>
      !u.route.part || !absent.has(u.route.part)
    );
    kids.push(el(
      "div",
      "uses",
      el(
        "span",
        "from",
        uses.length ? "Used by" : "Nothing uses this font yet.",
      ),
      ...uses.map((u) => {
        const chip = el("button", "chip", u.label);
        chip.type = "button";
        chip.onclick = () => ctx.go(u.route);
        return chip;
      }),
    ));

    if (!FIXED.includes(alias)) {
      const rm = el("button", "tog", "Remove font");
      rm.type = "button";
      rm.onclick = () => {
        delete fonts[alias];
        queueSave("fonts");
        render();
      };
      kids.push(el("div", "", rm));
    }
    const title = alias === "body"
      ? "Body"
      : alias === "display"
      ? "Display"
      : alias;
    return section(title, alias, kids);
  }

  function render(): void {
    const fonts = meta.fonts ??= {};
    const aliases = [
      ...FIXED,
      ...Object.keys(fonts).filter((a) => !FIXED.includes(a)),
    ];
    const add = el("button", "tog", "Add a font");
    add.type = "button";
    add.onclick = () => {
      let alias = "new-font";
      for (let i = 2; Object.hasOwn(fonts, alias); i++) alias = `new-font-${i}`;
      fonts[alias] = ""; // not saved until a typeface is chosen (see picker)
      render();
    };
    holder.replaceChildren(
      ...aliases.map(block),
      section("More fonts", "more-fonts", [
        el(
          "p",
          "hint",
          "Add a third font, like one for captions, then choose it in any book part.",
        ),
        el("div", "", add),
      ]),
    );
  }

  render();
  return [holder];
}
