// renderer/ornaments.js — art in a page's corners (spec §4.17). It sits outside
// the flow, so it can never move the text. Plain JS on the global `Paged`, like
// plates.js: server/export-html.ts inlines it, web/src/app.ts imports it.
Paged.registerHandlers(
  class Ornaments extends Paged.Handler {
    async finalizePage(pageElement) {
      // A section split across pages copies its attributes to every fragment;
      // only the first page carries the art.
      const openers = pageElement.querySelectorAll(
        "[data-ornaments]:not([data-split-from])",
      );
      const box = pageElement.querySelector(".pagedjs_pagebox");
      if (!box) return;
      for (const section of openers) {
        for (const o of JSON.parse(section.dataset.ornaments)) {
          const [y, x] = o.corner.split("-");
          const holder = document.createElement("div");
          holder.className = "page-ornament";
          holder.dataset.type = o.type;
          holder.dataset.slug = o.slug;
          holder.style.width = holder.style.height = o.size;
          holder.style[y] = holder.style[x] = o.inset;
          const img = document.createElement("img");
          img.alt = "";
          img.src = o.src;
          // Art narrower than its square hugs the corner it was drawn for, so
          // it hugs the page's corner once turned.
          img.style.objectPosition = o.from.split("-").reverse().join(" ");
          img.style.transform = `rotate(${o.turns * 90}deg)`;
          holder.append(img);
          box.append(holder);
          // Nothing waits on images outside the flow; PDF export would print
          // the page before the art arrived.
          await img.decode().catch(() => {});
        }
      }
    }
  },
);
