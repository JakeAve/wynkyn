// The Page ornaments block on a page's Style view (metadata `ornaments`, spec
// §4.17). The little page is the control: a click on a spot sets or clears it,
// showing the art as it will sit. No art needed to start: see the starters.
import { matterType } from "../../parser/types.ts";
import {
  CORNERS,
  drawnFor,
  EDGES,
  hug,
  turnsTo,
} from "../../metadata/ornaments.ts";
import type {
  Metadata,
  OrnamentPlacement,
  OrnamentSpot,
} from "../../metadata/types.ts";
import type { ImageFile } from "../../server/images.ts";
import { convertLength, parseLength } from "./config-data.ts";
import { type StarterKind, STARTERS } from "./ornament-starters.ts";
import { h, row, section, seg, stepper, type View } from "./panel-controls.ts";
import type { PanelContext } from "./style-catalog.ts";

const SHAPES: { kind: StarterKind; label: string; aria: string }[] = [
  { kind: "corners", label: "Corners", aria: "Art in the page's corners" },
  { kind: "edges", label: "Edges", aria: "Art at the middle of an edge" },
  { kind: "border", label: "Border", aria: "A line or frame around the page" },
];
const RULES = [
  { style: "single", name: "Single" },
  { style: "double", name: "Double" },
  { style: "thin-thick", name: "Thin and thick" },
] as const;

const mm = (length: string) => parseLength(convertLength(length, "mm"))?.n ?? 0;
// ponytail: a named size ("A5") falls back to the mini page's default shape.
const trimOf = (meta: Metadata) => {
  const [w, h] = (meta.page?.size ?? "").trim().split(/\s+/).map(mm);
  return w && h ? { w, h } : null;
};
const shapeOf = (o: OrnamentPlacement): StarterKind =>
  o.kind === "rule" || o.kind === "frame"
    ? "border"
    : o.at?.some((s) => EDGES.includes(s))
    ? "edges"
    : "corners";

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
  // A part's section holds its chapters, and display matter is one page.
  const paged = type !== "part" && !matterType(type).display;
  let images: ImageFile[] = [];
  const urls = new Map<string, string>();
  // What the tray is for: a new ornament of a shape, or new art for a card.
  let picking: { shape?: StarterKind; card?: OrnamentPlacement } | null = null;

  const body = h("div", { class: "ornaments" });
  const add = h("button", { type: "button", class: "tog" }, "Add");
  add.onclick = () => {
    picking = picking ? null : {};
    loadImages();
    draw();
  };
  const redraw = () => {
    picking = null;
    save();
    draw();
  };

  const push = (o: OrnamentPlacement) => {
    ((meta.ornaments ??= {})[type] ??= []).push(o);
    redraw();
  };
  const place = (slug: string, frame: boolean) => {
    const card = picking?.card;
    if (card) {
      card.image = slug;
      return redraw();
    }
    if (frame) return push({ kind: "frame", image: slug });
    if (picking?.shape === "edges") {
      return push({ image: slug, at: ["top", "bottom"], size: "40mm" });
    }
    // The contents' entries run to the foot of the page: start it on top.
    const at: OrnamentSpot[] = type === "toc"
      ? ["top-left", "top-right"]
      : [...CORNERS];
    push({ image: slug, at });
  };

  const art = (slug: string | undefined) => {
    const img = h("img", { alt: "" });
    const url = slug && urls.get(slug);
    if (url) img.src = url;
    return img;
  };

  const miniPage = (o: OrnamentPlacement) => {
    const page = h("div", { class: "orn-page" });
    const trim = trimOf(meta);
    if (trim) page.style.aspectRatio = `${trim.w} / ${trim.h}`;
    // Drawn to scale, so the steppers show what they do.
    const scale = () => {
      const pct = (v: string) => `${(100 * mm(v)) / (trim?.w ?? 140)}%`;
      page.style.setProperty("--orn-size", pct(o.size ?? "25mm"));
      page.style.setProperty("--orn-inset", pct(o.inset ?? "6mm"));
    };
    scale();
    if (o.kind === "rule") {
      page.append(
        h("div", { class: `orn-frame orn-rule-${o.style ?? "single"}` }),
      );
    } else if (o.kind === "frame") {
      page.append(h("div", { class: "orn-frame" }, art(o.image)));
    } else {
      for (const spot of shapeOf(o) === "edges" ? EDGES : CORNERS) {
        const on = !!o.at?.includes(spot);
        const words = spot.replace("-", " ");
        const b = h("button", {
          type: "button",
          class: `orn-spot ${spot}`,
          "aria-pressed": String(on),
          "aria-label": words,
          title: `${on ? "Clear" : "Set"} ${words}`,
        });
        if (on) {
          const img = art(o.image);
          img.style.objectPosition = hug(drawnFor(o, spot));
          img.style.transform = `rotate(${turnsTo(o, spot) * 90}deg)`;
          b.append(img);
        }
        b.onclick = () => {
          o.at = on ? o.at!.filter((s) => s !== spot) : [...(o.at ?? []), spot];
          save();
          draw();
        };
        page.append(b);
      }
    }
    return { page, scale };
  };

  const lengthRow = (
    o: OrnamentPlacement,
    key: "size" | "inset" | "width",
    label: string,
    placeholder: string,
    after: () => void,
  ) =>
    row(
      label,
      stepper({
        value: o[key],
        placeholder,
        label,
        onChange: (next) => {
          if (next) o[key] = next;
          else delete o[key];
          after();
          v.changed("ornaments");
        },
      }),
    );

  const card = (o: OrnamentPlacement, i: number) => {
    const { page, scale } = miniPage(o);
    const shape = shapeOf(o);
    const rows: Node[] = [];
    if (o.kind === "rule") {
      rows.push(row(
        "Line",
        seg(
          RULES.map((r) => ({ value: r.style, label: r.name })),
          o.style ?? "single",
          (next) => {
            o.style = next ?? "single";
            save();
            draw();
          },
          "Line",
        ),
      ));
      rows.push(lengthRow(o, "width", "Thickness", "0.75pt", scale));
    } else if (o.kind !== "frame") {
      rows.push(lengthRow(o, "size", "Size", "25mm", scale));
    }
    rows.push(lengthRow(o, "inset", "From the edge", "6mm", scale));
    if (paged) {
      rows.push(row(
        "On",
        seg(
          [
            { value: "first", label: "First page" },
            { value: "all", label: "Every page" },
          ],
          o.pages ?? "first",
          (next) => {
            if (next === "all") o.pages = next;
            else delete o.pages;
            v.changed("ornaments");
          },
          "Which pages",
        ),
      ));
    }
    const acts = h("div", { class: "orn-acts" });
    if (o.kind !== "rule") {
      const change = h(
        "button",
        { type: "button", class: "tog" },
        "Change art",
      );
      change.onclick = () => {
        picking = { card: o, shape };
        draw();
      };
      acts.append(change);
    }
    if (!o.kind || o.kind === "art") {
      const turn = h("button", {
        type: "button",
        class: "tog",
        title: "Turn the art a quarter turn at every spot",
      }, "Turn");
      turn.onclick = () => {
        const ring = shape === "edges" ? EDGES : CORNERS;
        const at = ring.indexOf(drawnFor(o, ring[0]!));
        o["drawn-for"] = ring[(at + 3) % 4]!;
        save();
        draw();
      };
      acts.append(turn);
    }
    const remove = h("button", { type: "button", class: "tog" }, "Remove");
    remove.onclick = () => {
      list().splice(i, 1);
      redraw();
    };
    acts.append(remove);
    return h(
      "div",
      { class: "orn-card" },
      page,
      h("div", { class: "orn-rows" }, ...rows, acts),
    );
  };

  const tile = (name: string, kid: Node, pick: () => void) => {
    const b = h("button", {
      type: "button",
      class: "orn-tile",
      title: name,
      "aria-label": name,
    }, kid);
    b.onclick = pick;
    return b;
  };

  const addFile = async (file: File, frame: boolean, slug?: string) => {
    try {
      const added = await ctx.images.add(file, slug);
      images = [...images.filter((i) => i.slug !== added.slug), added];
      urls.set(added.slug, await ctx.images.url(added.name));
      // The view was rebuilt on fresh metadata while the file saved: this one's
      // `meta` is no longer what gets saved.
      if (!body.isConnected) {
        return ctx.images.note(`Added to the book's images as ${added.name}`);
      }
      place(added.slug, frame);
    } catch (err) {
      ctx.images.note(err instanceof Error ? err.message : String(err), true);
    }
  };

  const tray = (shape: StarterKind) => {
    const frame = shape === "border";
    const upload = h("input", {
      type: "file",
      accept: "image/*",
      hidden: "",
      "aria-label": "Upload an ornament",
    });
    upload.onchange = () => {
      const f = upload.files?.[0];
      if (f) void addFile(f, frame);
    };
    const uploadBtn = h(
      "button",
      { type: "button", class: "tog" },
      frame ? "Upload a whole-page frame" : "Upload image",
    );
    uploadBtn.onclick = () => upload.click();
    const starters = STARTERS.filter((s) => s.kind === shape);
    const own = images.filter((i) => !STARTERS.some((s) => s.slug === i.slug));
    return h(
      "div",
      { class: "orn-tray" },
      h(
        "div",
        { class: "orn-tiles" },
        ...(frame && !picking?.card
          ? RULES.map((r) =>
            tile(
              r.name,
              h("div", { class: `orn-frame orn-rule-${r.style}` }),
              () => push({ kind: "rule", style: r.style, inset: "7mm" }),
            )
          )
          : []),
        ...starters.map((s) =>
          tile(
            s.name,
            h("img", {
              alt: "",
              src: `data:image/svg+xml,${encodeURIComponent(s.svg)}`,
            }),
            () => {
              if (images.some((i) => i.slug === s.slug)) place(s.slug, frame);
              else {
                void addFile(
                  new File([s.svg], `${s.slug}.svg`, { type: "image/svg+xml" }),
                  frame,
                  s.slug,
                );
              }
            },
          )
        ),
        ...own.map((i) =>
          tile(
            i.slug,
            h("img", { alt: "", src: urls.get(i.slug) ?? "" }),
            () => place(i.slug, frame),
          )
        ),
      ),
      h("div", { class: "orn-acts" }, uploadBtn, upload),
    );
  };

  const shapes = () =>
    h(
      "div",
      { class: "orn-shapes" },
      ...SHAPES.map((s) => {
        const b = h("button", {
          type: "button",
          class: "tog orn-shape",
          title: s.aria,
          "aria-pressed": String(picking?.shape === s.kind),
        }, s.label);
        b.onclick = () => {
          picking = { shape: s.kind };
          draw();
        };
        return b;
      }),
    );

  function draw() {
    add.textContent = picking ? "Cancel" : "Add";
    body.replaceChildren(
      ...list().map(card),
      ...(picking && !picking.card ? [shapes()] : []),
      ...(picking?.shape ? [tray(picking.shape)] : []),
    );
  }

  // Only once a card or the tray needs it: most views never show either.
  let loading = false;
  function loadImages() {
    if (loading) return;
    loading = true;
    void ctx.images.list().then(async (found) => {
      // Merged: an upload may have landed while this was on its way.
      const added = images.filter((i) => !found.some((f) => f.slug === i.slug));
      images = [...found, ...added];
      await Promise.all(found.map(async (i) => {
        urls.set(i.slug, await ctx.images.url(i.name));
      }));
      if (body.isConnected) draw();
    }).catch((err) => {
      loading = false;
      ctx.images.note(err instanceof Error ? err.message : String(err), true);
    });
  }

  draw();
  if (list().length) loadImages();

  const el = section("Page ornaments", "ornaments", [body], add);
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
