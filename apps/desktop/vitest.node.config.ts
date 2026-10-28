import path from "node:path";
import { pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";
import { censusTestFiles } from "./scripts/node-test-census.mjs";
import {
  resolveLaneConcurrency,
  resolveNodeCoverageEnabled,
  resolveTestTimeoutMs,
} from "./scripts/node-test-lane-settings.mjs";
import {
  parseShardSpec,
  selectShard,
} from "./scripts/run-node-tests-shard.mjs";

/**
 * ISS-4933 — the main-process (Node environment) half of the desktop suite.
 *
 * Separate from `vitest.renderer.config.ts` on purpose: that config is jsdom
 * with the React/JSX aliases, and widening it to cover `test/**` would put
 * every main-process suite in a browser-shaped environment. Two configs, two
 * environments (PLN-1558 SCOPE-6).
 *
 * Suites import `vitest` directly (ISS-11262 retired the `node:test` alias
 * shim). `scripts/node-test-census.mjs` names the few files that still need
 * `tsx --test`'s runtime and why.
 */

/**
 * Which files this run covers, derived — never listed.
 *
 * `include` is the census's Vitest-eligible set narrowed by the same
 * `NODE_TEST_SHARD` partition `run-node-tests.mjs` has used since ISS-4638,
 * reusing `selectShard` rather than `vitest --shard`. Vitest's own sharding
 * partitions by its own ordering, which would orphan the tested
 * "union of shards drops no file" guarantee in
 * `test/run-node-tests-shard.test.ts` — the guarantee that makes a partition
 * bug loud, given a dropped file goes green by simply not running.
 *
 * EXPORTED so that guard can drive the real derivation for each shard and then
 * assert the shipped `include` below is exactly this function's output. A test
 * that only re-implemented the partition would stay green if `include` were
 * replaced with a hand-written glob.
 */
export function nodeLaneInclude(shardSpec = process.env.NODE_TEST_SHARD) {
  return selectShard(censusTestFiles().vitest, parseShardSpec(shardSpec));
}

/**
 * Resolved once, from `node-test-lane-settings.mjs` — the module both pools
 * read, so `NODE_TEST_TIMEOUT_MS` cannot mean two different things.
 *
 * This was briefly a local `Number.parseInt(…) || 120_000`, which is not the
 * same function: `|| ` only rejects `NaN` and `0`, so `NODE_TEST_TIMEOUT_MS=-5`
 * reached Vitest as `-5` (which it accepts, failing every test) while
 * `resolveTestTimeoutMs` clamped the legacy pool back to 120s. Two pools, one
 * suite, one env var, two rules.
 */
const perTestTimeoutMs = resolveTestTimeoutMs();

export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    environment: "node",
    include: nodeLaneInclude(),
    // Forks, not threads. These suites load native addons (better-sqlite3, the
    // Prisma engine) and spawn real child processes; worker_threads shares a
    // process-wide addon registry across them, which node:test never did — it
    // ran every file in its own child. `isolate` keeps that one-process-per-file
    // property, which a lot of this suite's global state quietly relies on.
    pool: "forks",
    isolate: true,
    // The width the legacy pool runs at, from the same resolver rather than a
    // second copy of the formula — see node-test-lane-settings.mjs for why the
    // number is what it is.
    maxWorkers: resolveLaneConcurrency(),
    // The `--test-timeout` the node:test runner passes (FEA-2399): most tests
    // here are milliseconds, but the gateway-server suite can approach 60s
    // under parallel local runs.
    testTimeout: perTestTimeoutMs,
    // The SAME number, not Vitest's 10s default. node:test has one
    // `--test-timeout` covering tests and hooks alike, so a suite whose setup
    // legitimately takes longer than 10s — golden-layer3's fixture build is
    // ~20s — passed for years and would start failing here on a difference in
    // default, not a difference in the code. Caught exactly that way.
    hookTimeout: perTestTimeoutMs,
    // ISS-7085 — this pool's OWN coverage, because the enclosing c8 lane cannot
    // see it. c8 collects process-tree V8 coverage, which credits the
    // `tsx --test` pool, this config's own module graph, and any child process a
    // test spawns — but a module Vitest imports into its worker is
    // Vite-transformed and never reported against a real source URL, so all
    // 1079 files on this pool contributed nothing. `report-coverage.mjs` merges
    // this map as a third lane.
    //
    // NO `include`, and that is the load-bearing difference from
    // `vitest.renderer.config.ts`. The renderer sets an all-files `include`
    // because its partition is `DenominatorKind.Source`; every partition this
    // lane feeds is `DenominatorKind.Execution` (report-coverage-lib.mjs), so
    // the universe must stay "what actually loaded". Adding an `include` here
    // would silently re-base four partitions' denominators onto the source tree
    // and make every historical comparison a different question.
    coverage: {
      enabled: resolveNodeCoverageEnabled(),
      provider: "v8",
      reporter: ["json"],
      reportsDirectory: "coverage/node-vitest",
      // Measurement lane, not a gate — same reason the renderer lane sets it:
      // a run with a failing test must still report what executed.
      reportOnFailure: true,
    },
    // ISS-5836's hermetic git environment is applied by the runner, which is
    // this config's only production entrypoint; a bare `vitest --config` run
    // inherits the operator's git config exactly as a bare `tsx --test` did.
    setupFiles: [
      path.resolve(
        import.meta.dirname,
        "../../scripts/vitest-setup-strip-tracer.ts"
      ),
    ],
  },
});
