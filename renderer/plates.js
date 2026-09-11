// renderer/plates.js — full-page illustrations as plates (spec §3.6.1).
// Paged.js has no page floats, so a full-page figure leaves the flow before
// layout and gets a page of its own right after the page its anchor lands on:
// the text around it still fills whole pages, and the plate interrupts the
// text mid-paragraph like a tipped-in plate. Plain JS on the global `Paged`:
// server/pipeline.ts inlines it after paged.polyfill.js, web/src/app.ts
// imports it.
Paged.registerHandlers(
  class Plates extends Paged.Handler {
    plates = [];

    // afterParsed, not beforeParsed: the web preview hands Paged.js an HTML
    // string, and only the parsed fragment is DOM in both entry points.
    afterParsed(parsed) {
      for (
        const fig of parsed.querySelectorAll("figure.placement-full-page")
      ) {
        let plate = fig.cloneNode(true);
        for (const el of [plate, ...plate.querySelectorAll("*")]) {
          for (const a of [...el.attributes]) {
            if (a.name.startsWith("data-")) el.removeAttribute(a.name);
          }
        }
        // Bare copies (tag + class) of the figure's ancestors, so the plate
        // gets the same cascade (.bml, the chapter, is- classes) as its text
        // without the ids and Paged.js refs/page names/breaks of the originals.
        for (let el = fig.parentElement; el; el = el.parentElement) {
          const shell = document.createElement(el.tagName);
          shell.className = `${el.className} plate-shell`;
          shell.append(plate);
          plate = shell;
        }
        const i = this.plates.push(plate) - 1;
        const anchor = document.createElement("span");
        anchor.className = "plate-anchor";
        anchor.dataset.plate = String(i);
        anchor.dataset.ref = `plate-anchor-${i}`; // Paged.js tracks nodes by ref
        fig.replaceWith(anchor);
      }
    }

    async finalizePage(pageElement, _page, _breakToken, chunker) {
      for (const anchor of pageElement.querySelectorAll(".plate-anchor")) {
        const page = chunker.addPage();
        // The "display" named page carries no running head or folio
        // (metadata/css-generator.ts).
        page.element.classList.add(
          "pagedjs_named_page",
          "pagedjs_display_page",
        );
        const plate = this.plates[anchor.dataset.plate].cloneNode(true);
        page.area.append(plate);
        // Nothing waits on images outside the flow; PDF export would print
        // the plate before its image arrived.
        await plate.querySelector("img")?.decode().catch(() => {});
      }
    }
  },
);
