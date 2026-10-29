/**
 * ISS-4933 — the dd-trace preload tokens, defined once.
 *
 * `NODE_OPTIONS=-r dd-trace/ci/init --import dd-trace/register.js` is what the
 * script-tier CI lanes set so the tracer instruments Vitest (see the
 * `TRACER_PRELOAD_EXPRESSION` in pr-test.yml). Several places have to take it
 * back out again, and each of them held its own copy of the token text: the
 * Vitest setup file that strips it inside a worker, the desktop runner that
 * strips it before spawning the legacy `node:test` pool, and the regression test
 * that proves a spawned child does not inherit it.
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

/**
 * ISS-8775 — moved here from `apps/desktop/scripts/node-test-lane-settings.mjs`,
 * which is where it happened to land first. Root build tooling and `apps/api`
 * both need it, and neither should reach into the desktop app for it, so it
 * lives beside the token list it reads and every caller imports it from here.
 *
 * Deliberately narrow: only a dd-trace preload goes, and everything else in
 * `NODE_OPTIONS` (`--max-old-space-size`, load-bearing on some lanes) stays.
 *
 * It matches every Node SPELLING of that preload, not just the exact token text
 * CI exports: `--require=dd-trace/ci/init` and `--import=dd-trace/register.js`
 * are the same instruction to Node, and a literal-substring strip left both in
 * place — so a lane that wrote the equals form kept crashing tsc while this
 * helper reported the environment clean (ISS-8775 review, whitlockk).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv} A copy; the caller's env is not mutated.
 */
export function withoutTracerPreload(env) {
  const nodeOptions = env.NODE_OPTIONS;
  if (nodeOptions === undefined || nodeOptions.length === 0) {
    return { ...env };
  }
  let stripped = nodeOptions;
  for (const pattern of TRACER_PRELOAD_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  stripped = stripped.replace(WHITESPACE_RUN, " ").trim();
  const next = { ...env };
  if (stripped.length > 0) {
    next.NODE_OPTIONS = stripped;
  } else {
    Reflect.deleteProperty(next, "NODE_OPTIONS");
  }
  return next;
}

const WHITESPACE_RUN = /\s+/g;
const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/g;

/**
 * The module specifier half of each token above — `dd-trace/ci/init`,
 * `dd-trace/register.js`. Derived rather than re-listed so the specifiers cannot
 * drift from the tokens the way the three copies of the token list once did.
 */
const TRACER_PRELOAD_SPECIFIERS = TRACER_PRELOAD_TOKENS.map((token) =>
  token.slice(token.indexOf(" ") + 1)
);

/**
 * One pattern per specifier, covering every flag Node accepts for a preload and
 * both separators: `-r spec`, `--require spec`, `--require=spec`,
 * `--import spec`, `--import=spec`. The trailing lookahead keeps a longer
 * specifier that merely starts with one of these from being truncated.
 */
const TRACER_PRELOAD_PATTERNS = TRACER_PRELOAD_SPECIFIERS.map(
  (specifier) =>
    new RegExp(
      String.raw`(?:^|\s)(?:-r|--require|--import)[\s=]+${specifier.replace(REGEX_METACHARACTER, String.raw`\$&`)}(?=\s|$)`,
      "g"
    )
);
