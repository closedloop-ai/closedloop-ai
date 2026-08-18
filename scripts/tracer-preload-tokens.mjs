/**
 * ISS-4933 — the dd-trace preload tokens, defined once.
 *
 * `NODE_OPTIONS=-r dd-trace/ci/init --import dd-trace/register.js` is what the
 * script-tier CI lanes set so the tracer instruments Vitest (see the
 * `TRACER_PRELOAD_EXPRESSION` in pr-test.yml). Three places have to know the
 * exact token text to take it back out again, and each of them held its own
 * copy: the Vitest setup file that strips it inside a worker, the desktop
 * runner that strips it before spawning the legacy `node:test` pool, and the
 * regression test that proves a spawned child does not inherit it.
 *
 * Byte-identity between those copies was load-bearing and asserted only in a
 * comment, which nothing fails on. If dd-trace ever ships a third preload
 * token, a list that is not this one silently falls behind and its lane starts
 * inheriting the token again — the exact failure the strippers exist to
 * prevent. So the list lives here and the copies import it.
 *
 * `.mjs` deliberately, and NOT `scripts/vitest-setup-strip-tracer.ts`: that file
 * exports nothing and strips `process.env` as a side effect of being imported,
 * so it cannot be the home for a shared value; and
 * `apps/desktop/scripts/node-test-lane-settings.mjs` runs under plain `node`
 * with no TypeScript loader, so a `.ts` module is not importable from it either.
 *
 * The sibling `.d.mts` keeps consumers outside the root scripts TypeScript
 * project on this same runtime constant. Root script consumers infer the same
 * `string[]` shape through `allowJs`; Desktop tests resolve the declaration.
 */

export const TRACER_PRELOAD_TOKENS = [
  "-r dd-trace/ci/init",
  "--import dd-trace/register.js",
];
