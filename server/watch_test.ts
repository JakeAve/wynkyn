// server/watch_test.ts
import { assertEquals } from "@std/assert";
import { watchTree } from "./watch.ts";

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

Deno.test("watchTree reports changed paths and stops cleanly", async () => {
  const dir = await Deno.makeTempDir();
  const seen = new Set<string>();
  const watcher = watchTree(dir, (paths) => {
    for (const p of paths) seen.add(p);
  }, { debounceMs: 50 });

  // macOS FSEvents can lag right after a watch starts — give it a beat.
  await new Promise((r) => setTimeout(r, 200));

  await Deno.writeTextFile(`${dir}/a.txt`, "one");
  await Deno.writeTextFile(`${dir}/b.txt`, "two");

  // Compare by suffix: FSEvents reports realpaths (/private/var/…) while
  // makeTempDir may return the /var/… symlink form.
  await waitFor(() =>
    [...seen].some((p) => p.endsWith("/a.txt")) &&
    [...seen].some((p) => p.endsWith("/b.txt"))
  );

  watcher.stop();
  seen.clear();
  await Deno.writeTextFile(`${dir}/c.txt`, "three");
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(seen.size, 0);

  await Deno.remove(dir, { recursive: true });
});
