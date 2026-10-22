// server/port.ts — the dev server's port for this checkout. Every git worktree
// gets its own, so two worktrees run `deno task dev` side by side without
// touching each other: the main checkout takes 8000, a linked worktree a stable
// port hashed from its folder name. `PORT` overrides both. `deno task setup`
// writes the same number into .claude/launch.json.
export function defaultPort(cwd = Deno.cwd()): number {
  const env = Deno.env.get("PORT");
  if (env) return Number(env);
  if (!isLinkedWorktree(cwd)) return 8000;
  // ponytail: FNV-1a of the folder name; two worktrees collide 1 in 999 — set PORT
  const name = cwd.slice(cwd.lastIndexOf("/") + 1);
  let h = 0x811c9dc5;
  for (const ch of name) {
    h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return 8001 + (h % 999);
}

// A linked worktree's `.git` is a file naming the main repository; the main
// checkout's is the directory itself.
export function isLinkedWorktree(cwd = Deno.cwd()): boolean {
  try {
    return Deno.statSync(`${cwd}/.git`).isFile;
  } catch {
    return false;
  }
}
