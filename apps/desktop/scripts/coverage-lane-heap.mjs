// @ts-check

/**
 * ISS-5299 — give c8's merge phase enough heap to finish.
 *
 * WHY THIS EXISTS. The node lane runs the whole desktop suite under
 * `c8 --reporter=json`. c8 writes one raw V8 coverage file per process into
 * `coverage/node/tmp`, then — AFTER every test has reported — loads that whole
 * set into ONE process to merge it into `coverage-final.json`. The tests are
 * not the memory cost; the merge is. On this branch the tmp set reached
 * **2.6 GB across 1,721 files**, and the merge died against Node's default
 * ~4 GB heap:
 *
 *     ℹ tests 9020   ℹ pass 9020   ℹ fail 0        <- the suite was GREEN
 *     Mark-Compact 4105.8 (4114.6) MB ... allocation failure
 *     FATAL ERROR: ... JavaScript heap out of memory
 *     Aborted (core dumped)   [ELIFECYCLE] exit code 134
 *
 * The failure mode is nastier than a plain red: c8 dies BEFORE writing
 * `coverage-final.json`, so `report-coverage.mjs` finds no node lane map and
 * reports every node-lane partition as 0% with "unreached files grew" — i.e. a
 * coverage PR whose measurement had actually improved read as a total
 * regression across collectors, gateway, shared, main and tooling.
 *
 * WHY A HEAP CAP AND NOT `--merge-async`. c8 ships `--merge-async` for exactly
 * this OOM, and it is dramatically cheaper (580 MB peak vs 5.0 GB). It is NOT
 * used here, deliberately, for two reasons:
 *
 *   1. It changes the numbers. Measured over the same 1,721-file tmp set, the
 *      incremental merge discovers a slightly different branch set: 31,434
 *      branches vs the synchronous merge's 31,335 (some files gain a branch,
 *      some lose one). The percentage barely moves (88.15% -> 88.16%), but the
 *      counts are not the same measurement.
 *   2. `report-coverage.mjs` folds the exact `test:node:coverage` string into
 *      its method identity, and `compareToBase` REFUSES to compare across
 *      identity drift (exit 3). Adding the flag would therefore trade this OOM
 *      for a discontinuity against main's published base — the coverage job
 *      stays red, and the PR comment loses the "vs main" delta that is the
 *      whole point of the lane.
 *
 * A heap cap has neither problem: it is not part of the method identity because
 * it genuinely is not part of the method. Verified — the merge's output is
 * BYTE-IDENTICAL at 8 GB and 16 GB (same sha256), so raising the ceiling
 * changes nothing except whether the process lives to write the file.
 *
 * CALIBRATION. Measured against the real 2.6 GB / 1,721-file tmp set from this
 * branch, replaying `c8 report` at a fixed cap:
 *
 *     4,096 MB  -> OOM (SIGABRT, exit 134)   <- Node's default on CI and on a
 *                                              typical dev box; the bug
 *     5,120 MB  -> ok, peak RSS 4.70 GB
 *     6,144 MB  -> ok, peak RSS 4.72 GB
 *     8,192 MB  -> ok, peak RSS 5.02 GB
 *    16,384 MB  -> ok, peak RSS 5.02 GB      <- peak stops growing; the working
 *                                              set really is ~4.5-5 GB
 *
 * So today's requirement sits between 4 GB and 5 GB, and 8 GB is ~1.8x it. That
 * is the headroom PRD-618 needs: the coverage campaign keeps ADDING tests, and
 * every added test file is more tmp data for this merge to hold. The cap is not
 * a reservation — a merge that needs 4.5 GB still only takes 4.5 GB — so the
 * larger ceiling costs a developer machine nothing.
 *
 * It is also affordable where it runs: both lanes run on `linux_8_core_arm`,
 * and by the time the merge starts every test child has exited, so the merge
 * has the runner to itself.
 *
 * WHEN THIS STOPS BEING ENOUGH. The symptom is unmistakable and always the
 * same: "JavaScript heap out of memory" / "Aborted (core dumped)" / exit 134
 * from `test:node:coverage`, with the test summary above it reporting `fail 0`.
 * Re-measure by replaying the merge alone against a captured tmp set (no need
 * to rerun the suite):
 *
 *     node --max-old-space-size=<cap> ./node_modules/c8/bin/c8.js report \
 *       --reporter=json --reports-dir /tmp/out --temp-directory coverage/node/tmp \
 *       --include 'src/**' --include 'scripts/**'
 *
 * If the honest answer becomes "more than the runner has", that is the point to
 * take `--merge-async` — and to land it in its own PR, so main republishes its
 * base under the new method identity and no branch eats the discontinuity.
 */
export const COVERAGE_MERGE_HEAP_MB = 8192;

const MAX_OLD_SPACE_FLAG = "--max-old-space-size";

/**
 * Compose the environment for the c8-wrapped node lane, raising the heap cap
 * for its merge phase.
 *
 * Appends rather than replaces: V8 takes the LAST occurrence of a repeated
 * flag, so an inherited `--max-old-space-size` (the web phase of both coverage
 * workflows sets one, and developers set them locally) is overridden without
 * discarding the rest of NODE_OPTIONS, which may legitimately carry loaders or
 * `--enable-source-maps`.
 *
 * @param {NodeJS.ProcessEnv} env Environment to derive from; not mutated.
 * @param {number} [heapMb] Cap in MB. Injectable so the test drives a value it
 *   controls instead of asserting against the constant it is checking.
 * @returns {NodeJS.ProcessEnv}
 */
export function withCoverageMergeHeap(env, heapMb = COVERAGE_MERGE_HEAP_MB) {
  const inherited = env.NODE_OPTIONS?.trim();
  const raised = `${MAX_OLD_SPACE_FLAG}=${heapMb}`;
  return {
    ...env,
    NODE_OPTIONS: inherited ? `${inherited} ${raised}` : raised,
  };
}

/**
 * The lanes `run-coverage-lanes.mjs` runs, in order, with the environment each
 * one gets.
 *
 * Exported rather than inlined in the entrypoint for the same reason
 * `run-node-tests-outcome.mjs` exists: the entrypoint is a top-level
 * side-effecting script that runs the entire desktop suite on import, so
 * nothing in it can be asserted directly. Building the table here lets a test
 * drive the REAL lane definitions — a change that drops the node lane's raised
 * heap fails that test instead of silently restoring the OOM.
 *
 * Only the node lane is raised. The renderer lane merges through
 * @vitest/coverage-v8, which streams its report and has never approached the
 * default ceiling.
 *
 * @param {NodeJS.ProcessEnv} env Base environment, normally `process.env`.
 * @returns {{ name: string, args: string[], env: NodeJS.ProcessEnv }[]}
 */
export function buildCoverageLanes(env) {
  return [
    {
      name: "node",
      args: ["run", "test:node:coverage"],
      env: withCoverageMergeHeap(env),
    },
    { name: "renderer", args: ["run", "test:renderer:coverage"], env },
  ];
}
