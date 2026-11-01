// renderer/ornaments.js — art fixed to the page (spec §4.17). It sits outside
// the flow, so it can never move the text. Plain JS on the global `Paged`, like
// plates.js: server/export-html.ts inlines it, web/src/app.ts imports it.
Paged.registerHandlers(
  class Ornaments extends Paged.Handler {
    async finalizePage(pageElement) {
      const box = pageElement.querySelector(".pagedjs_pagebox");
      if (!box) return;
      // A section split across pages copies its attributes to every fragment.
      // A chapter may end and the next start on one page: one border, not two.
      const seen = new Set();
      for (const section of pageElement.querySelectorAll("[data-ornaments]")) {
        const continued = section.hasAttribute("data-split-from");
        for (const o of JSON.parse(section.dataset.ornaments)) {
          if (continued && o.pages !== "all") continue;
          const key = JSON.stringify(o);
          if (seen.has(key)) continue;
          seen.add(key);
          const el = o.kind === "rule" ? rule(o) : art(o);
          box.append(el);
          // Nothing waits on images outside the flow; PDF export would print
          // the page before the art arrived.
          await el.querySelector("img")?.decode().catch(() => {});
        }
      }
    }
  },
);

function holder(o, kind) {
  const el = document.createElement("div");
  el.className = `page-ornament page-ornament-${kind}`;
  el.dataset.type = o.type;
  if (o.slug) el.dataset.slug = o.slug;
  return el;
}

function rule(o) {
  const el = holder(o, "rule");
  el.classList.add(`rule-${o.style}`);
  el.style.inset = o.inset;
  el.style.setProperty("--rule-width", o.width);
  return el;
}

function art(o) {
  const el = holder(o, o.kind === "frame" ? "frame" : "spot");
  const img = document.createElement("img");
  img.alt = "";
  img.src = o.src;
  el.append(img);
  if (o.kind === "frame") {
    el.style.inset = o.inset;
    return el;
  }
  el.style.width = el.style.height = o.size;
  const [y, x] = o.spot.split("-");
  if (x) el.style[y] = el.style[x] = o.inset;
  else {
    el.style[y] = o.inset;
    el.classList.add(y === "top" || y === "bottom" ? "mid-x" : "mid-y");
  }
  img.style.objectPosition = o.hug;
  img.style.transform = `rotate(${o.turns * 90}deg)`;
  return el;
}
