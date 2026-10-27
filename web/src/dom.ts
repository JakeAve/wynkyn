// web/src/dom.ts — the helpers every piece of the chrome uses.
export const $ = (id: string) => document.getElementById(id)!;

// Short, readable tail of an error for the footer; full text stays in the title.
export function brief(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 80);
}

// A localStorage read (no value) or write. Storage can be blocked; then a
// preference just doesn't survive a reload.
export function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // storage blocked
  }
  return null;
}
