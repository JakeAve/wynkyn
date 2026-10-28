// server/watch_test.ts
import { assertEquals } from "@std/assert";
import { watchTree } from "./watch.ts";
import { quietFor, until } from "../testing/wait.ts";

Deno.test("watchTree reports changed paths and stops cleanly", async () => {
  const dir = await Deno.makeTempDir();
  const seen = new Set<string>();
  const watcher = watchTree(dir, (paths) => {
    for (const p of paths) seen.add(p);
  }, { debounceMs: 50 });

  // clock: a fresh FSEvents watch has no ready signal; give it a beat.
  await new Promise((r) => setTimeout(r, 200));

  await Deno.writeTextFile(`${dir}/a.txt`, "one");
  await Deno.writeTextFile(`${dir}/b.txt`, "two");

  // Compare by suffix: FSEvents reports realpaths (/private/var/…) while
  // makeTempDir may return the /var/… symlink form.
  await until(() =>
    [...seen].some((p) => p.endsWith("/a.txt")) &&
    [...seen].some((p) => p.endsWith("/b.txt"))
  );

  watcher.stop();
  seen.clear();
  await Deno.writeTextFile(`${dir}/c.txt`, "three");
  await quietFor(300); // a stopped watch hears nothing
  assertEquals(seen.size, 0);

  await Deno.remove(dir, { recursive: true });
});
