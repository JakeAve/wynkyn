// web/src/shortcuts-dialog.ts — the Keyboard shortcuts dialog (spec:
// shortcuts): every command by section with its keys, a filter, and rebinding
// by recording. Click a row, press the keys: Esc cancels, Backspace restores
// the default, Delete unbinds, Tab passes through.
import { caution, combo, isMac, label, reserved } from "./keys.ts";
import type { Shortcuts } from "./shortcuts.ts";
import { h } from "./panel-controls.ts";
import { $ } from "./dom.ts";

export function installShortcutsDialog(s: Shortcuts): () => void {
  const dlg = $("shortcuts") as HTMLDialogElement;
  const filter = $("shortcuts-filter") as HTMLInputElement;
  const list = $("shortcuts-list");
  const note = $("shortcuts-note");
  const tip = note.textContent ?? "";
  let recording: string | null = null;
  // Commands that lost a key to a rebind, and the key: "was Ctrl+B".
  let was = new Map<string, string>();

  const say = (text: string, cls = "") => {
    note.textContent = text;
    note.className = `hint ${cls}`;
  };

  const render = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = s.commands().filter((c) => c.label.toLowerCase().includes(q));
    const sections = Map.groupBy(shown, (c) => c.section);
    list.replaceChildren();
    for (const [name, cmds] of sections) {
      list.append(h("div", { class: "nh" }, name));
      for (const c of cmds) {
        const keys = [
          ...new Set((s.keymap().byId[c.id] ?? []).map((k) => label(k))),
        ];
        const on = recording === c.id;
        const lost = was.get(c.id);
        const row = h(
          "button",
          {
            type: "button",
            class: "sc-row",
            "data-id": c.id,
            "aria-pressed": String(on),
          },
          h("span", { class: "sc-label" }, c.label),
          ...(on
            ? [
              h(
                "span",
                { class: "sc-hint" },
                `Press keys · ${label("escape")} cancels · ${
                  label("backspace")
                } default · ${label("delete")} none`,
              ),
            ]
            : [
              ...(lost ? [h("span", { class: "sc-hint" }, `was ${lost}`)] : []),
              ...(keys.length
                ? keys.map((k) => h("kbd", {}, k))
                : [h("span", { class: "sc-hint" }, "none")]),
            ]),
        );
        row.onclick = () => {
          recording = on ? null : c.id;
          render();
        };
        list.append(row);
      }
    }
    if (!shown.length) {
      list.append(h("p", { class: "book-empty" }, "No matches"));
    }
    if (recording) {
      list.querySelector<HTMLElement>(`[data-id="${recording}"]`)?.focus();
    }
  };

  const bind = (id: string, k: string | null) => {
    const other = k ? s.keymap().byCombo.get(k) : undefined;
    s.bind(id, k);
    if (k && other && other !== id) {
      // An earlier rebind of `other` can still win the combo: take it back.
      if (s.keymap().byCombo.get(k) !== id) {
        s.bind(other, (s.keymap().byId[other] ?? []).join(", "));
      }
      was.set(other, label(k));
      const name = s.commands().find((c) => c.id === other)?.label;
      say(`Took ${label(k)} from ${name}.`);
    }
  };

  // Window capture runs before shortcuts.ts's document capture, so a key being
  // recorded never runs its command.
  addEventListener("keydown", (e) => {
    const id = recording;
    if (!dlg.open || !id || e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    const k = combo(e);
    if (!k) return; // a modifier on its own: keep listening
    const why = reserved(k);
    if (why) return say(why, "sw-err");
    if (
      k !== "escape" && k !== "delete" && k !== "backspace" &&
      !/^(.*(ctrl|alt|cmd)\+.+|f\d+)$/.test(k)
    ) {
      return say(
        `${label(k)} types a character; add ${
          isMac ? "⌘, ⌥ or ⌃" : "Ctrl or Alt"
        }.`,
        "sw-err",
      );
    }
    say(tip);
    recording = null;
    if (k === "backspace") bind(id, null);
    else if (k === "delete") bind(id, "");
    else if (k !== "escape") {
      bind(id, k);
      const warn = caution(k);
      if (warn) say(warn, "warn");
    }
    render();
  }, true);

  $("shortcuts-done").onclick = () => dlg.close();
  filter.oninput = render;
  filter.onfocus = () => {
    if (recording) {
      recording = null;
      render();
    }
  };

  return () => {
    if (dlg.open) return dlg.close();
    filter.value = "";
    recording = null;
    was = new Map();
    say(tip);
    render();
    dlg.showModal();
    filter.focus();
  };
}
