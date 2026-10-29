// @ts-check

/**
 * ISS-4933 — the two knobs both desktop main-process lanes must agree on.
 *
 * `test:node` now runs two pools: Vitest for the census's Vitest set and
 * `tsx --test` for the remainder. They are configured in different files —
 * `vitest.node.config.ts` and `run-node-tests.mjs` — and each knob below was
 * briefly declared in both, which is the SSOT-drift-by-copy defect the repo
 * guidelines name outright: changing one leaves the other, silently, and the
 * two lanes then run the same suite under different rules.
 */

import { availableParallelism } from "node:os";

/**
 * The 120s per-test cap FEA-2399 set, or `NODE_TEST_TIMEOUT_MS`.
 *
 * Validated, not just parsed: `Number.parseInt("-5", 10) || 120_000` yields
 * `-5`, and Vitest accepts a negative `testTimeout`, so a typo'd override would
 * have failed every test on the Vitest lane while the legacy lane kept the
 * default. Most tests here are milliseconds; the gateway-server suite can
 * approach 60s under parallel local runs.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveTestTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.NODE_TEST_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * How many test files a desktop lane may run at once.
 *
 * Read by all three: both main-process pools (`vitest.node.config.ts` and
 * `run-node-tests.mjs`) and the renderer lane (`vitest.renderer.config.ts`,
 * ISS-9275 — it previously declared no width at all and took one worker per
 * core, which is what made its `asyncUtilTimeout` budgets unreliable).
 *
 * node:test isolates each file in its own child process and Vitest's `forks`
 * pool with `isolate: true` does the same, so concurrent files do not share
 * mutable state; the pre-ISS-4638 `--test-concurrency=1` pin serialized the
 * whole suite for no correctness benefit (verified: identical pass/fail at 1
 * vs N).
 *
 * Width per host is {@link laneConcurrencyFor}.
 *
 * @returns {number}
 */
export function resolveLaneConcurrency() {
  return laneConcurrencyFor(availableParallelism());
}

/**
 * ISS-7085 — whether the Vitest pool collects its own coverage this run.
 *
 * The node lane is one c8 invocation wrapping BOTH pools, and c8 attributes
 * only what runs outside a Vite-transformed worker: the `tsx --test` pool, this
 * runner's own module graph, and any child process a test spawns. Everything
 * the Vitest pool executes IN-WORKER is invisible to it — 1079 of the suite's
 * 1107 files — so that pool has to report its own map, the way the renderer
 * lane already does.
 *
 * It lives beside the other two knobs for the reason this module exists: the
 * flag is SET by `test:node:coverage` in package.json and READ by
 * `vitest.node.config.ts`, so a second copy of the string is exactly the drift
 * the docstring above warns about.
 *
 * Presence is not enough, and the negative spellings are enumerated rather than
 * left to truthiness: a shell that exports the name unconditionally, or a
 * developer who writes `DESKTOP_NODE_COVERAGE=false` to turn it off, must not
 * silently turn the lane ON. That matters more than it looks — this value now
 * feeds `nodeLaneSelectionHash`, so a truthy-by-accident setting would change
 * what the node partitions measure while the method identity still claimed the
 * runs were comparable.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function resolveNodeCoverageEnabled(env = process.env) {
  const raw = env.DESKTOP_NODE_COVERAGE?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return false;
  }
  return !NODE_COVERAGE_OFF_VALUES.has(raw);
}

const NODE_COVERAGE_OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * {@link resolveLaneConcurrency} with the host passed in, so the per-host width
 * is assertable on any machine.
 *
 * At least 4 (or every core, below 4), half the machine above 8 cores, and
 * never more than 8. The desktop PR gate is a 4-core runner and an 8-core host
 * still gets 4, so every CI lane keeps its width. ISS-12047: on a 10-core host
 * a 4-wide `test:node` took 551s alone and crossed the 900s whole-runner cap
 * beside one other turbo lane; 5 wide it finished at 59-68% of the cap in a full
 * `pnpm test`. Half, not all, because `pnpm test` runs this lane beside one
 * Vitest lane that also takes half (`resolveLaneWorkers` in
 * `@repo/vitest-config`). Capped at 8, the widest width measured: the renderer
 * lane shares this width, and each of its workers mounts the whole desktop shell
 * against a 15s `asyncUtilTimeout` (ISS-6732, ISS-9275).
 *
 * @param {number} cores
 * @returns {number}
 */
export function laneConcurrencyFor(cores) {
  return Math.max(Math.min(cores, 4), Math.min(Math.floor(cores / 2), 8));
}
