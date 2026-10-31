// The Corner ornaments block on a page's Style view (metadata `ornaments`, spec
// §4.17). The little page is the control: a click on a corner sets or clears it,
// showing the art as it will sit. No art needed to start: see the starters.
import type {
  Metadata,
  OrnamentCorner,
  OrnamentPlacement,
} from "../../metadata/types.ts";
import type { ImageFile } from "../../server/images.ts";
import { convertLength, parseLength } from "./config-data.ts";
import { STARTERS } from "./ornament-starters.ts";
import { h, row, section, stepper, type View } from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";

const CORNERS: OrnamentCorner[] = [
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
];
const WORDS = (c: OrnamentCorner) => c.replace("-", " ");
const FIRST_PAGE: Record<string, string> = {
  part: "First page of each part.",
  chapter: "First page of each chapter.",
  toc: "First page of the contents.",
};

const mm = (length: string) => parseLength(convertLength(length, "mm"))?.n ?? 0;
// ponytail: a named size ("A5") falls back to the mini page's default shape.
const trimOf = (meta: Metadata) => {
  const [w, h] = (meta.page?.size ?? "").trim().split(/\s+/).map(mm);
  return w && h ? { w, h } : null;
};

const turnsOf = (o: OrnamentPlacement, corner: OrnamentCorner) =>
  (CORNERS.indexOf(corner) - CORNERS.indexOf(o["drawn-for"] ?? "top-left") +
    4) % 4;

export function ornamentsBlock(
  ctx: PanelContext,
  v: View,
  type: string,
): { el: HTMLElement; reset(): Array<keyof Metadata> } {
  const { meta } = ctx;
  const list = () => meta.ornaments?.[type] ?? [];
  const save = () => {
    if (meta.ornaments && !meta.ornaments[type]?.length) {
      delete meta.ornaments[type];
      if (!Object.keys(meta.ornaments).length) delete meta.ornaments;
    }
    v.changed("ornaments");
  };
  let current = 0;
  let adding = false; // rarely used, so an unset page shows only its heading
  const add = h("button", { type: "button", class: "tog" }, "Add");
  add.onclick = () => {
    adding = !adding;
    draw();
  };
  let images: ImageFile[] = [];
  const urls = new Map<string, string>();

  const body = h("div", { class: "ornaments" });
  const place = (slug: string) => {
    const all = list();
    const o = all[current];
    if (o) o.image = slug;
    else {
      // The contents' entries run to the foot of the page: start it on top.
      const corners: OrnamentCorner[] = type === "toc"
        ? ["top-left", "top-right"]
        : [...CORNERS];
      ((meta.ornaments ??= {})[type] ??= []).push({ image: slug, corners });
      current = all.length;
    }
    save();
    draw();
  };

  const art = (slug: string, turns = 0) => {
    const img = h("img", { alt: "" });
    const url = urls.get(slug);
    if (url) img.src = url;
    img.style.transform = `rotate(${turns * 90}deg)`;
    return img;
  };

  const card = (o: OrnamentPlacement, i: number) => {
    const page = h("div", { class: "orn-page" });
    const trim = trimOf(meta);
    if (trim) page.style.aspectRatio = `${trim.w} / ${trim.h}`;
    // Drawn to scale, so the little page shows what the sliders do.
    const scale = () => {
      const pct = (v: string) => `${(100 * mm(v)) / (trim?.w ?? 140)}%`;
      page.style.setProperty("--orn-size", pct(o.size ?? "25mm"));
      page.style.setProperty("--orn-inset", pct(o.inset ?? "6mm"));
    };
    scale();
    for (const corner of CORNERS) {
      const on = o.corners.includes(corner);
      const b = h("button", {
        type: "button",
        class: `orn-corner ${corner}`,
        "aria-pressed": String(on),
        "aria-label": WORDS(corner),
        title: `${on ? "Clear" : "Set"} ${WORDS(corner)}`,
      });
      if (on) b.append(art(o.image, turnsOf(o, corner)));
      b.onclick = () => {
        current = i;
        o.corners = on
          ? o.corners.filter((c) => c !== corner)
          : [...o.corners, corner];
        save();
        draw();
      };
      page.append(b);
    }
    const turn = h("button", {
      type: "button",
      class: "tog",
      title: "Turn the art a quarter turn in every corner",
    }, "Turn");
    turn.onclick = () => {
      const at = CORNERS.indexOf(o["drawn-for"] ?? "top-left");
      o["drawn-for"] = CORNERS[(at + 3) % 4]!;
      save();
      draw();
    };
    const remove = h("button", { type: "button", class: "tog" }, "Remove");
    remove.onclick = () => {
      list().splice(i, 1);
      current = Math.max(0, list().length - 1);
      save();
      draw();
    };
    const c = h(
      "div",
      {
        class: i === current && list().length > 1 ? "orn-card on" : "orn-card",
      },
      page,
      h(
        "div",
        { class: "orn-rows" },
        row(
          "Size",
          stepper({
            value: o.size,
            placeholder: "25mm",
            label: "Ornament size",
            onChange: (next) => {
              if (next) o.size = next;
              else delete o.size;
              scale();
              v.changed("ornaments");
            },
          }),
        ),
        row(
          "From the edge",
          stepper({
            value: o.inset,
            placeholder: "6mm",
            label: "Distance from the page's edge",
            onChange: (next) => {
              if (next) o.inset = next;
              else delete o.inset;
              scale();
              v.changed("ornaments");
            },
          }),
        ),
        h("div", { class: "orn-acts" }, turn, remove),
      ),
    );
    c.onclick = (e) => {
      if (
        current === i || (e.target as Element).closest("button,input,select")
      ) {
        return;
      }
      current = i;
      draw();
    };
    return c;
  };

  const tile = (slug: string, name: string, src: string, pick: () => void) => {
    const chosen = list()[current]?.image === slug;
    const img = h("img", { alt: "", src });
    const b = h("button", {
      type: "button",
      class: "orn-tile",
      "aria-pressed": String(chosen),
      title: name,
      "aria-label": name,
    }, img);
    b.onclick = pick;
    return b;
  };

  const addFile = async (file: File, slug?: string) => {
    const added = await ctx.images.add(file, slug);
    images = [...images.filter((i) => i.slug !== added.slug), added];
    urls.set(added.slug, await ctx.images.url(added.name));
    place(added.slug);
  };

  const tray = () => {
    const upload = h("input", {
      type: "file",
      accept: "image/*",
      hidden: "",
      "aria-label": "Upload an ornament",
    });
    upload.onchange = () => {
      const f = upload.files?.[0];
      if (f) void addFile(f);
    };
    const uploadBtn = h(
      "button",
      { type: "button", class: "tog" },
      "Upload image",
    );
    uploadBtn.onclick = () => upload.click();
    const own = images.filter((i) => !STARTERS.some((s) => s.slug === i.slug));
    return h(
      "div",
      { class: "orn-tray" },
      h(
        "div",
        { class: "orn-tiles" },
        ...STARTERS.map((s) => {
          const src = `data:image/svg+xml,${encodeURIComponent(s.svg)}`;
          return tile(s.slug, s.name, src, () => {
            if (images.some((i) => i.slug === s.slug)) place(s.slug);
            else {
              void addFile(
                new File([s.svg], `${s.slug}.svg`, { type: "image/svg+xml" }),
                s.slug,
              );
            }
          });
        }),
        ...own.map((i) =>
          tile(i.slug, i.slug, urls.get(i.slug) ?? "", () => place(i.slug))
        ),
      ),
      h("div", { class: "orn-acts" }, uploadBtn, upload),
    );
  };

  function draw() {
    const all = list();
    add.hidden = all.length > 0;
    add.textContent = adding ? "Cancel" : "Add";
    if (!all.length && !adding) return body.replaceChildren();
    const another = h(
      "button",
      { type: "button", class: "tog" },
      "Add another",
    );
    another.onclick = () => {
      const used = new Set(all.flatMap((o) => o.corners));
      const free = CORNERS.filter((c) => !used.has(c));
      all.push({
        image: all[current]!.image,
        corners: free.length ? free : [...CORNERS],
      });
      current = all.length - 1;
      save();
      draw();
    };
    const hint = FIRST_PAGE[type];
    body.replaceChildren(
      ...(hint ? [h("p", { class: "from" }, hint)] : []),
      ...all.map(card),
      all.length ? h("div", { class: "orn-acts" }, another) : "",
      h(
        "p",
        { class: "from" },
        all.length
          ? "Pick art for the selected ornament. Turn it if it faces the wrong way."
          : "Pick art to set it in the corners.",
      ),
      tray(),
    );
  }

  draw();
  void ctx.images.list().then(async (found) => {
    images = found;
    await Promise.all(found.map(async (i) => {
      urls.set(i.slug, await ctx.images.url(i.name));
    }));
    draw();
  });

  const el = section("Corner ornaments", "ornaments", [body], add);
  return {
    el,
    reset() {
      if (!meta.ornaments?.[type]) return [];
      delete meta.ornaments[type];
      if (!Object.keys(meta.ornaments).length) delete meta.ornaments;
      return ["ornaments"];
    },
  };
}
