#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticGitEnv } from "./hermetic-git-env.mjs";
import { censusTestFiles } from "./node-test-census.mjs";
import {
  resolveLaneConcurrency,
  resolveTestTimeoutMs,
  withoutTracerPreload,
} from "./node-test-lane-settings.mjs";
import {
  appendStepSummary,
  classifyRunnerOutcome,
  DEFAULT_RUNNER_TIMEOUT_MS,
} from "./run-node-tests-outcome.mjs";
import { parseShardSpec, selectShard } from "./run-node-tests-shard.mjs";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

// ISS-4933. The desktop main-process suite now runs on Vitest, so it reports to
// Datadog Test Optimization instead of being ~900 files of dark, required gate.
// `node-test-census.mjs` owns which lane each file goes to and why. The legacy
// lane SHRINKS but does not disappear: ISS-4934 converts the `mock`/TestContext
// files, and what is left after it are files that need `tsx --test`'s runtime
// rather than node:test's API (Node loader hooks, real-V8-stack assertions), so
// this is a two-pool runner for the foreseeable future, not a temporary one.
const census = censusTestFiles();

// ISS-4638. `NODE_TEST_SHARD=<index>/<total>` takes every Nth file of a sorted
// list; unset runs everything. The pre-merge `desktop-node` job in pr-test.yml
// sets it from its matrix (with the total read from `strategy.job-total`, so the
// two cannot drift); desktop-release.yml, the post-merge validation/auto-revert
// lanes and a local `pnpm test` all leave it unset and still run the whole
// suite. The partition property is asserted in test/run-node-tests-shard.test.ts
// — a shard that dropped files would otherwise go green while simply not
// running them.
//
// BOTH lanes are sharded by the same partition. Pinning the legacy lane to shard
// 1 would have been simpler, but it is over a hundred files including some of
// the slowest suites in the tree, so it would make shard 1 the whole job's
// critical path while shards 2 and 3 idled.
const shard = parseShardSpec(process.env.NODE_TEST_SHARD);
const vitestFiles = selectShard(census.vitest, shard);
const legacyFiles = selectShard(census.nodeTest, shard);
const totalFiles = census.vitest.length + census.nodeTest.length;
const selectedFiles = vitestFiles.length + legacyFiles.length;

if (selectedFiles === 0) {
  console.error(
    shard
      ? `[run-node-tests] shard ${shard.index}/${shard.total} selected 0 of ${totalFiles} test files — more shards than files`
      : "[run-node-tests] no test files found"
  );
  process.exit(1);
}

if (shard) {
  console.log(
    `[run-node-tests] shard ${shard.index}/${shard.total}: running ${selectedFiles} of ${totalFiles} test files`
  );
}
console.log(
  `[run-node-tests] ${vitestFiles.length} file(s) on Vitest, ${legacyFiles.length} still on node:test (ISS-4934)`
);

// Both knobs come from node-test-lane-settings.mjs, which vitest.node.config.ts
// also reads. They were briefly declared in both files; two copies of the same
// number configuring two pools over one suite is how the pools drift apart.
const testConcurrency = resolveLaneConcurrency();
const testTimeoutMs = resolveTestTimeoutMs();

// Whole-runner wall-clock cap.
//
// `--test-timeout` above bounds a test FUNCTION; it does nothing about a handle
// a test leaked. A test that throws before its cleanup line (an assertion
// failure between `service.start()` and `service.stop()`, say) strands a live
// `setInterval`, and node:test then blocks on an event loop that never drains
// — the whole job sat until the 30-minute GitHub cap and reported a wall-clock
// cancellation instead of the failing test's name (run 30669096552).
//
// `--test-force-exit` would end the process as soon as every test reported, but
// it would ALSO make a passing-but-leaking test exit green, removing this lane's
// only signal for a real cleanup regression (wongk review). So bound the runner
// externally instead: a leak still fails the run — the signal is kept — it just
// costs minutes instead of the job cap, and the spec reporter has already named
// the failing test on stdout by then, so the failure stays attributable.
//
// CALIBRATION (ISS-5969, superseding ISS-5256). This cap wraps `test:node`
// ONLY. It does NOT bound the `Test desktop` / `Test Desktop` workflow STEP,
// which also runs prebuild, db:generate, the dependency-cruiser boundary check,
// test:prisma-baseline and test:renderer. Deriving this number from a step
// duration overstates the suite by minutes; measure the runner's own
// `[run-node-tests] test:node used …` line instead.
//
// Measured on the UNSHARDED lanes, which is what the cap has to cover. The
// pre-merge lane in pr-test.yml runs one shard (ISS-4638), so it consumes
// roughly 1/`total` of the cap and cannot calibrate it.
//
//   linux_4_core_arm — `validate-tests` in desktop-test-validation.yml, and the
//     identical `classify-tests` in desktop-test-auto-revert.yml. 17 green runs
//     on THIS two-pool runner, 2026-08-11T20:54..08-12T03:26: min 276.3s,
//     median 285.2s, max 314.2s. Stable — max/median is 1.10x. The split cut
//     this lane ~15%: the four runs immediately before the merge were 326.2s,
//     330.9s, 340.3s and 346.3s, median 335.6s. ISS-4933 gained headroom here.
//   macos-latest — `release` in desktop-release.yml. NOT YET MEASURABLE on this
//     runner: the last release ran four hours before the split merged. Its five
//     pre-split greens, 2026-08-06..08-11, were 325.9s, 391.3s, 392.9s, 444.5s
//     and 510.4s — median 392.9s, max 510.4s — plus the killed run below.
//
// macOS IS NOW THE SLOWER LANE. Like for like on the pre-split runner its
// median is 392.9s against Linux's 335.6s (1.17x), and on sha 7cf67b482 —
// measured on both the same day — Linux ran 323.8s while macOS was killed at
// 900s. The superseded comment claimed Linux was slower and sized one shared
// default against it; that is false in both comparisons. Do not restore it.
//
// WHY 900s IS RE-AFFIRMED AND NOT RAISED. Two releases died at this cap
// (v0.16.1087 at the old 720s on 08-05, v0.16.1238 at 900s on 08-11), and both
// read as the cap being too tight. Neither is. On both, the release job's
// TEST-FREE steps inflated with everything else — Install+Lint+Typecheck came
// to 393s and 329s against 121-255s across the other 14 releases in the window,
// making those two the slowest hosts measured. The host moved, not the suite.
//
// A slow host cannot be bought off with a bigger cap, because the `release`
// job's own `timeout-minutes: 45` binds BEFORE this cap does. Taking the two
// most recent green releases (08-10 and 08-11, i.e. after the ISS-5300/5302/5303
// coverage PRs grew the suite):
//
//   whole release job   1616s and 1754s of 2700s  ->  1.54-1.67x headroom
//   its test:node       444.5s and 510.4s of 900s ->  1.76-2.02x headroom
//
// Packaging, signing and notarization (554-677s) run AFTER the suite, so a host
// slow enough to push test:node past 900s has already pushed the job past its
// own 2700s. Raising the cap would not have saved v0.16.1238 — it would have
// traded this runner's named cap message for an anonymous GitHub 45-minute
// cancellation inside `Package Desktop`. That is a host and job-budget problem;
// it is not this number's to fix.
//
// ONE SHARED CAP IS STILL CORRECT, for the same reason: the slower lane's
// binding constraint is its job cap, so a per-lane macOS override would have to
// be SMALLER to trip first, killing more releases rather than fewer. 900s is
// 2.86x the Linux max and clears every macOS green observed.
//
// It still fails inside every enclosing job cap, so a leaked handle is reported
// BY THIS RUNNER — named and attributable — rather than as a GitHub wall-clock
// cancellation. test/run-node-tests-job-cap.test.ts pins that relationship:
// it reads the three unsharded lanes' `timeout-minutes` and goes red if this cap
// plus the worst measured pre-suite work stops fitting inside any of them.
//
// Override the cap for a single run with NODE_TEST_RUNNER_TIMEOUT_MS. Do not
// re-derive it from a single run. DRIFT_WARN_PERCENT in
// run-node-tests-outcome.mjs warns while there is still margin; a SUSTAINED
// annotation ON LINUX is the signal to re-measure, because that lane's host is
// steady. A macOS annotation reports the host at least as much as the suite.
const parsedRunnerTimeout = Number.parseInt(
  process.env.NODE_TEST_RUNNER_TIMEOUT_MS ?? "",
  10
);
const runnerTimeoutMs =
  Number.isInteger(parsedRunnerTimeout) && parsedRunnerTimeout > 0
    ? parsedRunnerTimeout
    : DEFAULT_RUNNER_TIMEOUT_MS;

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const startedAtMs = Date.now();

// ISS-5836. Every git spawn in the suite inherits this — the fixtures' own
// spawns AND the git that the PRODUCTION code under test shells out to
// (`git worktree add/remove/prune`, `git clone`, `git push`), which no fixture
// helper can reach. Without it the suite executes whatever hooks the operator's
// `~/.gitconfig` points `core.hooksPath` at, so its result depends on machine
// state it never meant to read. See hermetic-git-env.mjs.
const childEnv = hermeticGitEnv();

/** @type {{ error?: { code?: string, message?: string }, signal?: string | null, status?: number | null }[]} */
const results = [];

if (vitestFiles.length > 0) {
  // No file list on the command line: `vitest.node.config.ts` derives `include`
  // from the same census and the same `selectShard`, so the set cannot drift
  // between the two, and Vitest's positional arguments are substring FILTERS
  // rather than an exact list.
  results.push(
    runLane(
      ["exec", "vitest", "run", "--config", "vitest.node.config.ts"],
      childEnv
    )
  );
}

// The legacy lane still runs even when Vitest failed: this is a gate, and
// stopping at the first red would report the other lane's files as absent
// rather than as whatever they actually are.
if (legacyFiles.length > 0) {
  results.push(
    runLane(
      [
        "exec",
        "tsx",
        "--test",
        `--test-timeout=${testTimeoutMs}`,
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-concurrency=${testConcurrency}`,
        ...legacyFiles,
      ],
      // WITHOUT the dd-trace preload the `desktop-node` step sets. It is there
      // for Vitest; dd-trace has no node:test integration at any version, so on
      // this pool it is a module preload per file that reports nothing.
      withoutTracerPreload(childEnv)
    )
  );
}

// ISS-5114: classify BEFORE branching on `result.error`. A `spawnSync` timeout
// sets error.code === "ETIMEDOUT" *and* signal === "SIGTERM", so the old
// error-first order reported every whole-runner timeout as "failed to launch
// test runner" and dumped the ~600-entry argv, hiding the cap under a wall of
// filenames while the unrun tail showed up as a large `cancelled` count. See
// scripts/run-node-tests-outcome.mjs for why this lives in its own module.
//
// WITH TWO LANES, "the first failing lane" is not good enough. A cap that fires
// on the SECOND lane while the first merely had failing tests would be reported
// as those test failures — status 1, no error, no signal — and the cap's three
// explanatory messages would never print, which is ISS-5114's exact defect moved
// up one level: the operator sees a red suite plus 124 files that inexplicably
// produced no output, instead of "the run hit its wall-clock cap".
//
// So an abnormal END (a timeout or a signal, whichever lane it happened in)
// outranks an ordinary non-zero exit. `runLane` guarantees every selected lane
// appears here, including one the cap left no room to start.
const abnormal = results.find((result) => result.error || result.signal);
const failing =
  abnormal ?? results.find((result) => (result.status ?? 1) !== 0);
const outcome = classifyRunnerOutcome({
  error: failing?.error,
  signal: failing?.signal,
  // `failing ? failing.status : 0`, NOT `failing?.status ?? 0`: the outcome
  // module ends with `exitCode: status ?? 1` so an unknown status fails CLOSED,
  // and collapsing a failing lane's null status to 0 here would undo exactly
  // that on the one value that decides the gate.
  status: failing ? failing.status : 0,
  elapsedMs: Date.now() - startedAtMs,
  runnerTimeoutMs,
});

for (const message of outcome.messages) {
  console.error(message);
}

// ISS-5256: report the cap's remaining margin on EVERY run, not only on the run
// that finally exceeds it. Before this, the only way to learn the suite had grown
// into its cap was a red release.
//
// stdout, not stderr: GitHub Actions reads `::` workflow commands off the
// runner's stdout, and this is telemetry from a healthy run, not a diagnostic.
// `messages` above stays on stderr — it only ever describes an abnormal end.
console.log(outcome.summaryLine);
for (const annotation of outcome.annotations) {
  console.log(annotation);
}
// The summary row reports THIS runner, not the enclosing step. On the lanes that
// still run the whole `test` chain (desktop-release.yml, the post-merge
// validation/auto-revert lanes) that step also covers prebuild, prisma-baseline
// and test:renderer, none of which the cap bounds, and the step's own duration is
// already on the job page.
//
// Not reached on a turbo cache hit: `desktop#test` is cacheable and the release
// lane invokes it through `turbo test --filter=desktop`, so a replayed task
// prints the captured stdout line (flagged by turbo as a replay) but appends no
// new summary row. The pre-merge lanes invoke this script directly — since
// ISS-4638 as `pnpm --filter desktop run test:node` from `desktop-node`, one
// process per shard — and never take that path.
appendStepSummary(outcome.summaryLine);

// `process.exitCode`, NOT `process.exit()`. Under CI, stdout is a pipe and its
// writes are asynchronous, so an immediate `process.exit()` can truncate exactly
// the telemetry the lines above just queued — the headroom line and the
// `::warning::` annotation GitHub parses. Nothing here holds the event loop open
// (`spawnSync` and `appendFileSync` are synchronous), so setting the code lets
// Node drain stdout and exit with it.
process.exitCode = outcome.exitCode;

/**
 * Run one lane, bounded by whatever is left of the whole-runner cap.
 *
 * The cap is shared, not per-lane: it exists to bound this SCRIPT's wall clock
 * (see the calibration above), and two lanes each granted the full 900s would
 * silently double it.
 *
 * A lane that cannot start because an EARLIER lane spent the cap returns the
 * SAME shape `spawnSync` produces for a timeout, rather than `null` or a skip.
 * Those files not running is exactly the wall-clock failure the cap describes,
 * and the one thing this must never do is let the second lane silently not run
 * while the script exits 0 on the first lane's success.
 *
 * The FIRST lane is never short-circuited, however much of the cap the clock
 * says is left. With nothing having run yet, an exhausted budget means the cap
 * itself is tiny — `NODE_TEST_RUNNER_TIMEOUT_MS=1`, which is exactly how
 * run-node-tests-headroom.test.ts drives the drift annotation — not that a
 * previous lane consumed it. Reporting that as `timed_out` describes the wrong
 * thing AND suppresses the `::warning::` drift annotation, which that branch
 * deliberately drops as noise on top of a real cap kill. So spawn it and let
 * `spawnSync`'s own timeout say what happened.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ error?: { code?: string, message?: string }, signal?: string | null, status?: number | null }}
 */
function runLane(args, env) {
  const remainingMs = runnerTimeoutMs - (Date.now() - startedAtMs);
  if (remainingMs <= 0 && results.length > 0) {
    return {
      error: {
        code: "ETIMEDOUT",
        message: `[run-node-tests] whole-runner cap spent before this lane could start (${args[1]})`,
      },
      signal: "SIGTERM",
      status: null,
    };
  }
  return spawnSync(pnpm, args, {
    cwd: desktopDir,
    stdio: "inherit",
    timeout: Math.max(1, remainingMs),
    env,
  });
}
