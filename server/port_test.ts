import { assert, assertEquals } from "@std/assert";
import { defaultPort } from "./port.ts";

Deno.test("defaultPort: 8000 at the main checkout, a stable 8001–8999 in a worktree, PORT wins", async () => {
  const dir = await Deno.makeTempDir();
  const saved = Deno.env.get("PORT");
  Deno.env.delete("PORT");
  try {
    await Deno.mkdir(`${dir}/main/.git`, { recursive: true });
    assertEquals(defaultPort(`${dir}/main`), 8000);
    await Deno.mkdir(`${dir}/feature-x`);
    await Deno.writeTextFile(`${dir}/feature-x/.git`, "gitdir: elsewhere\n");
    const p = defaultPort(`${dir}/feature-x`);
    assert(p >= 8001 && p <= 8999, `${p}`);
    assertEquals(defaultPort(`${dir}/feature-x`), p);
    Deno.env.set("PORT", "9123");
    assertEquals(defaultPort(`${dir}/feature-x`), 9123);
  } finally {
    if (saved === undefined) Deno.env.delete("PORT");
    else Deno.env.set("PORT", saved);
    await Deno.remove(dir, { recursive: true });
  }
});
