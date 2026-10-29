// scripts/setup.ts — `deno task setup`, safe to re-run: wires the git hooks,
// writes this checkout's .claude/launch.json with its own dev port
// (server/port.ts), and in a linked worktree points books/ at the main
// checkout's library, since books/ is gitignored and a worktree starts without one.
import { defaultPort, isLinkedWorktree } from "../server/port.ts";

function git(...args: string[]): string {
  const out = new Deno.Command("git", { args, stdout: "piped" }).outputSync();
  return new TextDecoder().decode(out.stdout).trim();
}

git("config", "core.hooksPath", ".githooks");
await Deno.chmod(".githooks/pre-commit", 0o755);

const port = defaultPort();
await Deno.mkdir(".claude", { recursive: true });
await Deno.writeTextFile(
  ".claude/launch.json",
  JSON.stringify(
    {
      version: "0.0.1",
      configurations: [{
        name: "dev",
        runtimeExecutable: "deno",
        runtimeArgs: ["task", "dev"],
        port,
      }, {
        // The hosted app's build, served as plain files (no server API).
        name: "site",
        runtimeExecutable: "deno",
        runtimeArgs: ["task", "serve:site"],
        port: 8010,
      }],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `hooks wired; dev server → http://localhost:${port}/ (.claude/launch.json)`,
);

if (isLinkedWorktree()) {
  try {
    await Deno.lstat("books");
  } catch {
    const main = await Deno.realPath(
      `${git("rev-parse", "--git-common-dir")}/..`,
    );
    await Deno.symlink(`${main}/books`, "books");
    console.log(`books/ → ${main}/books (the main checkout's library)`);
  }
}
