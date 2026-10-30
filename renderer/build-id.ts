// renderer/build-id.ts — names the layout code a cached preview page came
// from: the first 16 hex of SHA-256 over vendor/pagedjs/paged.js,
// renderer/folios.js, plates.js and ornaments.js. build-id_test.ts fails when it
// is stale; `UPDATE_GOLDEN=1 deno test -A renderer/build-id_test.ts` rewrites it.
export const BUILD_ID = "43a7508ae9e72795";
