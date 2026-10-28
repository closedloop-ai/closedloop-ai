#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutTracerPreload } from "../../../scripts/tracer-preload-tokens.mjs";
import {
  DESKTOP_TEST_STRICT_ENV,
  hermeticGitEnv,
} from "./hermetic-git-env.mjs";
import { censusTestFiles } from "./node-test-census.mjs";
import {
  resolveLaneConcurrency,
  resolveTestTimeoutMs,
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
// lane is down to the files that need `tsx --test`'s runtime rather than
// node:test's API (a child process that inherits tsx's loader, a real-V8-stack
// assertion), so this is a permanent two-pool runner, not a temporary one.
const census = censusTestFiles();

// ISS-4638. `NODE_TEST_SHARD=<index>/<total>` takes every Nth file of a sorted
// list; unset runs everything. The pre-merge `desktop-node` job in pr-test.yml
// sets it from its matrix (with the total read from `strategy.job-total`, so the
// two cannot drift), as do the macOS nightly and desktop-release.yml's
// `test_linux`; the release workflow's macOS `release` job, the post-merge
// validation/auto-revert lanes and a local `pnpm test` leave it unset and still
// run the whole suite. The partition property is asserted in test/run-node-tests-shard.test.ts
// — a shard that dropped files would otherwise go green while simply not
// running them.
//
// BOTH lanes are sharded by the same partition, so each file runs in exactly one
// shard whichever lane owns it.
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
  `[run-node-tests] ${vitestFiles.length} file(s) on Vitest, ${legacyFiles.length} on node:test (VITEST_INCOMPATIBLE_FILES)`
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
// only signal for a real cleanup regression (whitlockk review). So bound the runner
// externally instead: a leak still fails the run — the signal is kept — it just
// costs minutes instead of the job cap, and the spec reporter has already named
// the failing test on stdout by then, so the failure stays attributable.
//
// CALIBRATION (ISS-5969, superseding ISS-5256). This cap wraps `test:node`
// ONLY. It does NOT bound the `Test desktop` / `Test Desktop` workflow STEP,
// which also runs prebuild, db:generate, the dependency-cruiser boundary check
// and test:renderer. Deriving this number from a step
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
//   macos-latest — `release` in desktop-release.yml, and since FEA-4224 the
//     nightly `test-node-macos` in desktop-testnode-macos-nightly.yml. NOT YET
//     MEASURABLE on this runner when this was written: the last release ran four
//     hours before the split merged. Its five pre-split greens, 2026-08-06..08-11,
//     were 325.9s, 391.3s, 392.9s, 444.5s and 510.4s — median 392.9s, max 510.4s
//     — plus the killed run below. The nightly lane now produces a macOS
//     `test:node used …` line every day on the post-split runner; ISS-9937 below
//     is that measurement.
//
// RE-MEASURED 2026-08-28 (ISS-8326), because the drift warning fired and this
// is the response that comment asks for. The cap is UNCHANGED; what follows
// replaces the runtimes above as the current figures, not the reasoning.
//
//   linux_4_core_arm — `validate-tests`, 6 consecutive greens
//     2026-08-28T05:45..07:37Z: 448.4s, 455.4s, 457.2s, 475.5s, 487.4s, 489.9s.
//     Median 466.4s, max 489.9s = 54% of the cap. Still stable (max/median
//     1.05x), and 1.63x the 285.2s median measured on 08-12: the suite grew,
//     the host did not.
//   macos-latest — `release`, the three most recent greens: 482.6s (08-25,
//     run 32911785220), 671.3s (08-26, run 32974379535), 493.1s (08-27,
//     run 33082274702). Max 671.3s = 74%, one point under DRIFT_WARN_PERCENT.
//     The nightly macOS lane FEA-4224 built to produce a daily figure landed on
//     main at 02:47Z that morning and had not yet ticked, so `release` was still
//     the only macOS source AT THAT TIME. It is not any more — see ISS-9937.
//
// RE-MEASURED 2026-09-10 (ISS-9937), on the NIGHTLY, which is the source the
// note above was waiting for. Every scheduled run 08-28..09-10, read off each
// job's own `test:node used …` line rather than a step duration:
//
//   468.5s (08-28)  791.4s (08-29)  501.1s (08-30)  769.2s (08-31)
//   679.9s (09-01)  723.2s (09-02)  825.8s (09-03)  800.1s (09-04)
//   755.0s (09-05)  717.9s (09-06)  835.0s (09-07)  842.2s (09-08)
//   760.3s (09-09)  900.3s (09-10, KILLED at the cap, zero failing tests)
//
// Min 468.5s = 52%, median 764.8s = 84%, max 900.3s = 100%. ELEVEN of the
// fourteen are past DRIFT_WARN_PERCENT; ten of those emitted its annotation and
// the eleventh is the 09-10 kill, which suppresses one by design. The kill
// refused the Desktop release for the rest of the day (run 34455600707), and a
// 19:37Z re-dispatch the same evening read 856.4s = 95% — so it was not one
// unlucky host.
//
// WHAT THAT DISTRIBUTION SAYS, and it is not "the suite grew". min to max is
// 1.92x across fourteen nights of essentially one suite on one host class —
// ISS-5969's ~2x macOS variance, now measured on the lane that gates releases
// instead of inferred from test-free steps. A ~2x band cannot fit under a fixed
// cap when the median is at 85%: the kill needed no regression, only an
// ordinarily slow morning. That is a MARGIN problem, so the answer is to make
// each run smaller, not to move the line it crosses.
//
// ISS-9937 SHARDED THE NIGHTLY 3-wide for that reason, reusing `NODE_TEST_SHARD`
// exactly as pr-test.yml's `desktop-node` does. The figures above are therefore
// the last WHOLE-SUITE macOS population this lane will produce; do not re-derive
// the cap or the warn threshold from them, because they describe a lane shape
// that no longer exists. `release` remains unsharded and is still calibrated by
// the whole-suite numbers.
//
// WHAT THE 93% REPORT WAS. ISS-8326 opened on a local run that used 837.8s.
// That is not a lane this cap is calibrated against and not a measurement of the
// suite: it was a developer Mac carrying a 10-core load average between 20 and
// 180. Both CI lanes read 49-74% the same day. The rule the drift warning states
// — do not re-derive from a single run, and a macOS annotation reports the host
// at least as much as the suite — is exactly what that number needed.
//
// WHERE THE GROWTH IS: CONCENTRATED, NOT UNIFORM. Per-file durations from the
// 448.4s Linux run above (1338 files, 14,638 tests) sum to 1019.4s across 4
// workers. The median file is 42ms and 830 files are under 100ms; the top 10 are
// 25.7% of that total and the top 50 are 48.9%. Six of the twenty slowest are
// the suites that test THIS runner and its census — run-node-tests-shard 63.5s,
// node-test-census 45.5s, node-test-lane-settings 20.9s,
// node-vitest-coverage-attribution 19.8s, stress-node-tests-lib 11.3s,
// run-node-tests-headroom 9.0s — 170s, 17% of the suite. So the file COUNT is
// not what moves this number, and the lever, when one is needed, is those files
// rather than the 830 that cost nothing.
//
// CORRECTED 2026-09-05 (ISS-9275). That paragraph read the cost as "all of it
// subprocess spawns"; it was not. It was `censusTestFiles()`, which those
// suites call directly and which every runner they spawn calls again on import.
// A spawn is ~0.2s of node startup wrapped around seconds of census. The census
// parsed each of ~1,500 files TWICE — `installsLoaderHook` built one
// `ts.SourceFile`, `isVitestEligible` built another with `setParentNodes: true`
// that nothing reads — and memoised nothing, so all ~15 call sites in a lane run
// re-derived the whole tree, and every test file anyone added was paid for by
// each of them. That is why the lane grew 48% (778.0s -> 1151.5s) on 3% more
// files (1437 -> 1481) between 2026-09-04 and 09-05 and took the coverage-main
// measurement red: seven census suites were +453s of the +768s.
//
// Parse-once, no parent pointers, and a memo on the default TEST_DIR fixed it,
// with byte-identical census output and byte-identical shard partitions. Same
// tree, same host, unsharded, only that change (so NOT comparable to the CI
// figures above — read the ratios, not the seconds): those seven suites went
// 198.2s -> 73.7s of test time, 2.7x.
//
//     run-node-tests-shard 68.9 -> 19.4    node-test-census 48.8 -> 4.9
//     node-test-lane-settings 26.4 -> 17.8 node-vitest-coverage-attribution 21.7 -> 15.3
//     stress-node-tests-lib 11.7 -> 4.9    git-fixture-hermeticity 10.2 -> 5.3
//     run-node-tests-headroom 10.4 -> 6.1
//
// The lever ISS-8326 pointed at has now been pulled once. It does not remove
// these suites from the top of the list — they still spawn real runners, which
// is the point of them — so re-measure here rather than assuming the shape
// above still holds.
//
// THE SHARD COUNT STILL FITS, and it is not a function of the file count.
// `selectShard` takes every Nth file, so 3 shards split that 1019.4s of file
// time as 275s/298s/446s (max/min 1.62x — the partition balances files, not
// cost). The heaviest shard is ~446s over 4 workers against the same 900s cap
// each shard process gets, and `desktop-node` is observed at ~2.9m inside a
// 30-minute job cap. 4-wide would be 1.52x and 5-wide 1.33x; neither is worth a
// matrix change at this margin.
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
// it reads the unsharded lanes' `timeout-minutes` and goes red if this cap
// plus the worst measured pre-suite work stops fitting inside any of them.
//
// Override the cap for a single run with NODE_TEST_RUNNER_TIMEOUT_MS. Do not
// re-derive it from a single run. DRIFT_WARN_PERCENT in
// run-node-tests-outcome.mjs warns while there is still margin; a SUSTAINED
// annotation ON LINUX is the signal to re-measure, because that lane's host is
// steady.
//
// A macOS annotation still reports the host as much as the suite — but ISS-9937
// is what that sentence used to be missing. It was written as a reason to
// DISCOUNT the macOS lane, and on a host with a ~2x band it is the opposite: a
// sustained annotation there says the lane has no p100 margin left, which is a
// true and actionable finding even when the suite did not grow. Eleven nights
// of it preceded the 09-10 cap kill. Read a sustained macOS annotation as "this
// lane can no longer absorb a slow host", and answer it by making each run
// smaller — shard it, or shorten its slowest files — never by raising the cap.
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
//
// ISS-10194 adds the other half of the same idea: `GIT_ALLOW_PROTOCOL=file`
// inside `hermeticGitEnv()` so a git that escaped its fake cannot reach
// github.com, and `DESKTOP_TEST_STRICT_ENV` so an override that failed to
// install fails here rather than degrading to the real binary.
const childEnv = { ...hermeticGitEnv(), ...DESKTOP_TEST_STRICT_ENV };

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
// validation/auto-revert lanes) that step also covers prebuild and
// test:renderer, neither of which the cap bounds, and the step's own duration is
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
