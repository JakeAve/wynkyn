// web/src/dom.ts — the two helpers every piece of the chrome uses.
export const $ = (id: string) => document.getElementById(id)!;

// Short, readable tail of an error for the footer; full text stays in the title.
export function brief(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 80);
}
