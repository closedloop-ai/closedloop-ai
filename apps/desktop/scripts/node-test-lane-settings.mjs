// @ts-check

/**
 * ISS-4933 — the two knobs both desktop main-process lanes must agree on.
 *
 * `test:node` now runs two pools: Vitest for the shim-compatible files and
 * `tsx --test` for the remainder. They are configured in different files —
 * `vitest.node.config.ts` and `run-node-tests.mjs` — and each knob below was
 * briefly declared in both, which is the SSOT-drift-by-copy defect the repo
 * guidelines name outright: changing one leaves the other, silently, and the
 * two lanes then run the same suite under different rules.
 */

import { availableParallelism } from "node:os";
import { TRACER_PRELOAD_TOKENS } from "../../../scripts/tracer-preload-tokens.mjs";

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
 * How many test files either pool may run at once.
 *
 * node:test isolates each file in its own child process and Vitest's `forks`
 * pool with `isolate: true` does the same, so concurrent files do not share
 * mutable state; the pre-ISS-4638 `--test-concurrency=1` pin serialized the
 * whole suite for no correctness benefit (verified: identical pass/fail at 1
 * vs N). The desktop PR gate is a 4-core runner, and higher local widths create
 * resource pressure without improving the serialized renderer/build floor
 * documented in pr-test.yml.
 *
 * @returns {number}
 */
export function resolveLaneConcurrency() {
  return Math.min(availableParallelism(), 4);
}

/**
 * `NODE_OPTIONS` with the dd-trace preload tokens removed.
 *
 * The `desktop-node` step sets the preload so the tracer instruments VITEST.
 * dd-trace has no `node:test` integration at any version, so forwarding it to
 * the legacy pool buys nothing and costs a module preload on every one of its
 * files — and, worse, any of them that spawns a child with a temp `cwd` gets
 * `Cannot find module 'dd-trace/ci/init'` from a variable it never set. The
 * Vitest lane strips the same tokens inside its workers via
 * `scripts/vitest-setup-strip-tracer.ts`; this is that rule applied one process
 * earlier, for the pool that has no setup file to do it in. Both read the token
 * list from `scripts/tracer-preload-tokens.mjs`, so a token added there reaches
 * every stripper — this file used to hold its own copy, kept in step only by a
 * comment claiming byte-identity, which nothing failed on when it stopped
 * being true.
 *
 * Deliberately narrow: only the tracer tokens go, and everything else in
 * `NODE_OPTIONS` (`--max-old-space-size`, load-bearing on some lanes) stays.
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
  for (const token of TRACER_PRELOAD_TOKENS) {
    stripped = stripped.replaceAll(token, "");
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
