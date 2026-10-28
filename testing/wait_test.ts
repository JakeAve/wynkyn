import { assertEquals, assertRejects } from "@std/assert";
import { eventually, until } from "./wait.ts";

Deno.test("eventually retries a throwing check, and fails with its last error", async () => {
  let n = 0;
  assertEquals(
    await eventually(() => {
      if (++n < 3) throw new Error("not yet");
      return n;
    }),
    3,
  );
  await assertRejects(
    () =>
      eventually(() => {
        throw new Error("never");
      }, 60),
    Error,
    "never",
  );
});

Deno.test("until returns on the first match and names what it waited for", async () => {
  let n = 0;
  await until(() => ++n === 2);
  assertEquals(n, 2);
  await assertRejects(
    () => until(() => false, "a miracle", 60),
    Error,
    "a miracle",
  );
});
