// renderer/build-id.ts — names the layout code a cached preview page came
// from: the first 16 hex of SHA-256 over vendor/pagedjs/paged.js,
// renderer/folios.js and renderer/plates.js. build-id_test.ts fails when it
// is stale; `UPDATE_GOLDEN=1 deno test -A renderer/build-id_test.ts` rewrites it.
export const BUILD_ID = "5a3e92a8afac9c70";
