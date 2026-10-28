// No test waits on a guessed number of milliseconds: a pause that passes on
// a laptop fails on a slow CI runner. Wait for the state the assertion is
// about (testing/wait.ts `until`, Playwright's locator waits); a pause before
// asserting nothing happened is `quietFor`. A sleep that is neither carries a
// `// clock: <why>` on its line or the line above, and the reason must hold
// on a runner ten times slower.
import { assertEquals } from "@std/assert";

const SLEEP = /waitForTimeout\(|setTimeout\(/;

async function* testFiles(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const url = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* testFiles(url);
    else if (e.name.endsWith("_test.ts")) yield url;
  }
}

Deno.test("tests don't sleep on a guess", async () => {
  const unexplained: string[] = [];
  const root = new URL("../", import.meta.url);
  for await (const file of testFiles(root)) {
    if (file.pathname.endsWith("/testing/clock_test.ts")) continue;
    const lines = (await Deno.readTextFile(file)).split("\n");
    lines.forEach((line, i) => {
      if (!SLEEP.test(line)) return;
      if (`${lines[i - 1] ?? ""}\n${line}`.includes("// clock:")) return;
      unexplained.push(
        `${file.pathname.slice(root.pathname.length)}:${i + 1}`,
      );
    });
  }
  assertEquals(
    unexplained,
    [],
    "wait for the state instead (testing/wait.ts), or give a `// clock:` reason",
  );
});
