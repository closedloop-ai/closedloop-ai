// @ts-check

/**
 * ISS-5303 — the pure half of `stress-node-tests.mjs`.
 *
 * The entrypoint cannot be imported by a test: at module scope it spawns the
 * configured test file up to 50 times and calls `process.exit(1)` on the first
 * failure. Its pure logic — reading a bounded positive integer out of the
 * environment, and choosing which runner an iteration spawns — lives here so
 * every branch can be driven.
 */

/**
 * Positive-integer environment override, or `fallback`.
 *
 * `Number.parseInt` is deliberately lenient (it truncates and ignores trailing
 * text), so the contract is "the leading integer, if it is positive". A value
 * that parses to `0`, to a negative number, or to nothing at all falls back —
 * every one of those would otherwise be a stress run that does no work, loops
 * backwards, or hands `spawnSync` a nonsense timeout.
 *
 * @param {string} name Environment variable to read.
 * @param {number} fallback Used when `name` is unset or does not parse to a
 *   positive integer.
 * @param {NodeJS.ProcessEnv} [env] Injected so tests drive every branch without
 *   mutating `process.env`.
 * @returns {number}
 */
export function positiveIntEnv(name, fallback, env = process.env) {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Which runner a stress iteration spawns. */
export const StressLane = {
  NodeTest: "node:test",
  Vitest: "vitest",
};

/**
 * The lane one stress iteration should run on, taken from the census rather
 * than assumed.
 *
 * ISS-4934. This tool used to hardcode `tsx --test`, which was true while every
 * file in `test/` was a node:test file. It is not any more: point `STRESS_FILE`
 * at a converted suite and `tsx --test` runs it right up to the first `vi.*`
 * call, which throws "Vitest failed to access its internal state" — so the
 * nightly flake hunt reports a reproducible failure that only ever describes
 * the wrong runner. `censusTestFiles()` already owns which lane every file
 * belongs to, and it is the same object `run-node-tests.mjs` and
 * `vitest.node.config.ts` route by, so the three cannot disagree.
 *
 * Membership in the VITEST list is the discriminator, not absence from the
 * legacy one: the census covers `test/*.test.ts` only, and everything outside
 * it (an excluded suite, a path typo) keeps the `tsx --test` behaviour it has
 * always had, including the same loud error for a file that does not exist.
 *
 * The two argv shapes stay in the ENTRYPOINT rather than moving here with the
 * decision, because `scripts/lint/node-test-lane-coverage.ts` discovers this
 * lane by reading the runner file a manifest script names and looking for a
 * `"--test"` argument. Extracting the argv one module further took the stress
 * lane out of that census while its Datadog exemption stayed registered — the
 * silent-coverage-hole failure that guard exists to make loud.
 *
 * @param {string} testFile Test file, relative to `apps/desktop`.
 * @param {{ vitest: string[] }} census Output of `censusTestFiles()`.
 * @returns {string} A {@link StressLane} member.
 */
export function stressLane(testFile, census) {
  return census.vitest.includes(testFile)
    ? StressLane.Vitest
    : StressLane.NodeTest;
}
