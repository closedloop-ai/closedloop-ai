// @ts-check
import { appendFileSync } from "node:fs";

/**
 * ISS-5114 (propagation half) — classify how the desktop `node:test` runner
 * ended, so the whole-runner wall-clock cap is reported as itself.
 *
 * Why this exists: `spawnSync(..., { timeout })` that fires sets BOTH
 * `error.code === "ETIMEDOUT"` AND `signal === "SIGTERM"`. The runner script
 * used to check `result.error` first, so every timeout printed "failed to
 * launch test runner" followed by the entire ~600-entry argv — burying the
 * cause under a wall of filenames while the tail of the suite was reported as
 * CANCELLED. The observable shape ("cancelled: 565", "failed to launch") reads
 * as "the suite is broken / the machine is overloaded" rather than "the run hit
 * its 12-minute cap", and multiple lanes lost real time to that misreading.
 *
 * Keeping the decision here (rather than inline in the script) makes it
 * testable: the script itself is a top-level side-effecting entrypoint that runs
 * the whole suite on import.
 */

/**
 * @typedef {"timed_out" | "launch_failed" | "signaled" | "completed"} RunnerOutcomeKind
 */

/**
 * @typedef {object} RunnerOutcome
 * @property {RunnerOutcomeKind} kind
 * @property {string[]} messages Lines to print to stderr, in order. Empty for `completed`.
 * @property {number} exitCode
 * @property {string} summaryLine One line of headroom telemetry, emitted on EVERY
 *   run regardless of kind (ISS-5256). This is the observability that was missing:
 *   the cap's margin was only ever visible from a run that had already died.
 * @property {string[]} annotations GitHub Actions workflow-command lines. Populated
 *   only when the run crossed `DRIFT_WARN_PERCENT`, so a healthy suite stays quiet
 *   and the annotation keeps meaning something.
 */

export const RunnerOutcomeKind = /** @type {const} */ ({
  TimedOut: "timed_out",
  LaunchFailed: "launch_failed",
  Signaled: "signaled",
  Completed: "completed",
});

/**
 * ISS-5256, re-affirmed by ISS-5969 — the share of the whole-runner cap a run
 * may consume, as a whole percent, before it is reported as drift.
 *
 * The cap is only useful while the suite stays well under it: the 2026-08-05
 * release died because a margin nobody was watching had shrunk to 1.21x. This
 * is that watch. 75% of the 900s cap is 675s, and it fires while there is still
 * room to act rather than at the cliff.
 *
 * IT MEANS DIFFERENT THINGS PER LANE, because their hosts do. Linux runs
 * 276-314s with max/median 1.10x, so an annotation there is suite growth and
 * the signal to re-measure.
 *
 * macOS host speed varies ~2x run to run (ISS-5969, on the release job's
 * test-free steps; ISS-9937 measured the same 1.92x band on the nightly's own
 * `test:node used …` line, 468.5-900.3s across 2026-08-28..09-10). This comment
 * used to draw the conclusion "so a macOS annotation reports the host at least
 * as often as the suite" and leave it there. THAT IS HALF AN ANSWER, and the
 * missing half cost a release on 2026-09-10: against a ~2x host band, a lane
 * whose MEDIAN sits at 84% of the cap has no p100 margin at all, so a sustained
 * macOS annotation is a true report about the LANE'S MARGIN even when it is not
 * a report about suite growth. Ten of those fourteen nights annotated and an
 * eleventh was past the line, and then the twelfth was the kill. Read it as
 * "this lane can no longer absorb a slow host"
 * and shorten or SPLIT the work — which is what ISS-9937 did, sharding the
 * nightly 3-wide. Still check the job's test-free steps before touching the
 * suite or this number.
 *
 * NOT RE-DERIVED HERE, deliberately. The obvious next move is to recompute this
 * threshold against the nightly's 08-28..09-10 population, and that population
 * is exactly the one the sharding changes: those are whole-suite figures and the
 * lane now runs thirds. Re-deriving from them would pin the number to a lane
 * shape that no longer exists. Re-derive when post-shard nightlies exist.
 *
 * IT WARNS, AND IT MUST NOT GATE. ISS-8326 asked; the answer is measured, not a
 * preference. A gate here is the 900s cap re-spelled as 675s, and the lane it
 * would fail first is `release` on macOS, whose highest recent green is 671.3s
 * (2026-08-28 re-measurement in run-node-tests.mjs) — 74%, one point under this
 * line, on a host ISS-5969 measured varying ~2x run to run. Gating would convert
 * host variance into a failed Desktop release while the suite itself still had
 * 228s of real margin, which is the failure mode this threshold exists to warn
 * about rather than cause. The response to an annotation is to re-measure and,
 * if the suite really grew, shorten it; the cap is what fails a run.
 *
 * A WHOLE PERCENT, deliberately: it is the same figure `describeHeadroom` prints,
 * so the decision and the displayed number are one value and cannot contradict
 * each other. Keeping a separate 0.75 fraction alongside it would reintroduce
 * exactly that gap.
 */
export const DRIFT_WARN_PERCENT = 75;

/**
 * ISS-5256, re-affirmed by ISS-5969 against the two-pool runner — the default
 * whole-runner wall-clock cap, in milliseconds.
 *
 * Lives here rather than inline in the entrypoint so the value the runner ships
 * is the same one the tests assert against. Inlined, a revert to the old 720s
 * would leave the suite green while undoing the fix it is here to make.
 *
 * The calibration — per-lane measurements, why macOS is now the slower lane, and
 * why a bigger number does not save a release on a slow host — is documented at
 * the use site in run-node-tests.mjs. test/run-node-tests-job-cap.test.ts pins
 * this value against the unsharded lanes' own job caps, so it cannot grow past
 * the point where GitHub would cancel the job first.
 * `NODE_TEST_RUNNER_TIMEOUT_MS` overrides it.
 */
export const DEFAULT_RUNNER_TIMEOUT_MS = 15 * 60_000;

const TIMEOUT_ERROR_CODE = "ETIMEDOUT";
const MS_PER_SECOND = 1000;
const PERCENT = 100;

/**
 * @param {object} input
 * @param {{ code?: string, message?: string } | undefined} input.error `spawnSync` result.error
 * @param {string | null | undefined} input.signal `spawnSync` result.signal
 * @param {number | null | undefined} input.status `spawnSync` result.status
 * @param {number} input.elapsedMs Wall clock spent in the child
 * @param {number} input.runnerTimeoutMs The configured cap
 * @returns {RunnerOutcome}
 */
export function classifyRunnerOutcome({
  error,
  signal,
  status,
  elapsedMs,
  runnerTimeoutMs,
}) {
  // Check the timeout FIRST. It is the only case that presents as an `error`
  // and a `signal` simultaneously, and it is the case that most needs to be
  // named rather than mistaken for a launch failure.
  const timedOut =
    error?.code === TIMEOUT_ERROR_CODE ||
    (Boolean(signal) && elapsedMs >= runnerTimeoutMs);
  const headroom = describeHeadroom(elapsedMs, runnerTimeoutMs);

  if (timedOut) {
    return {
      summaryLine: headroom.summaryLine,
      // A timeout is already a hard, self-describing failure; a "you are near the
      // cap" warning on top of "you hit the cap" is noise.
      annotations: [],
      kind: RunnerOutcomeKind.TimedOut,
      messages: [
        `[run-node-tests] test runner exceeded its ${runnerTimeoutMs}ms whole-runner cap ` +
          `(elapsed ${elapsedMs}ms${signal ? `, killed via ${signal}` : ""}) and was killed. ` +
          "This is a WALL-CLOCK cap, not a launch failure and not a broken suite.",
        "[run-node-tests] Every test that reported above is attributable — read those failures " +
          "first. The tests listed as cancelled simply never got to run; they are not failures.",
        "[run-node-tests] Two usual causes: (a) a test LEAKED A HANDLE (an un-cleared " +
          "setInterval/setTimeout, an open socket or watcher — commonly a test that threw before " +
          "its own cleanup line), so the runner never exited; or (b) the run genuinely needed " +
          "more wall clock than the cap allows on this host. Raise it for one run with " +
          "NODE_TEST_RUNNER_TIMEOUT_MS to tell (a) from (b).",
      ],
      exitCode: 1,
    };
  }

  if (error) {
    return {
      ...headroom,
      kind: RunnerOutcomeKind.LaunchFailed,
      messages: [
        "[run-node-tests] failed to launch test runner",
        error.message ?? String(error),
      ],
      exitCode: 1,
    };
  }

  if (signal) {
    return {
      ...headroom,
      kind: RunnerOutcomeKind.Signaled,
      messages: [`[run-node-tests] test runner exited via ${signal}`],
      exitCode: 1,
    };
  }

  // A run that FAILED still reports its headroom: "red and nearly out of cap" is
  // exactly the state worth knowing about before it becomes "killed at the cap".
  return {
    ...headroom,
    kind: RunnerOutcomeKind.Completed,
    messages: [],
    exitCode: status ?? 1,
  };
}

/**
 * Put one headroom line on the GitHub Actions run summary page, so a green
 * release's `test:node` elapsed-vs-cap is readable without opening the job log.
 *
 * Lives here, beside the line it writes, so the write is reachable from a test:
 * the entrypoint is a top-level script that runs the whole suite on import, and
 * an untested `appendFileSync` in it could be deleted without anything going red.
 *
 * Best-effort by contract. A summary-file failure must never reach the caller —
 * this runner's exit code is the merge-queue and Desktop-release verdict, and it
 * belongs to the tests, not to telemetry.
 *
 * @param {string} line
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {void}
 */
export function appendStepSummary(line, env = process.env) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  try {
    appendFileSync(summaryPath, `${line}\n`);
  } catch {
    // The line is already on stdout; the summary page is the nicety, not the record.
  }
}

/**
 * Describe how much of the whole-runner cap this run consumed (ISS-5256).
 *
 * Private on purpose: the decision belongs to `classifyRunnerOutcome`, which is
 * the only production caller, so a test that drives the threshold drives the
 * real entry point rather than a helper the runner could stop calling.
 *
 * @param {number} elapsedMs
 * @param {number} runnerTimeoutMs
 * @returns {{ summaryLine: string, annotations: string[] }}
 */
function describeHeadroom(elapsedMs, runnerTimeoutMs) {
  const usedFraction = elapsedMs / runnerTimeoutMs;
  const elapsedSeconds = (elapsedMs / MS_PER_SECOND).toFixed(1);
  const capSeconds = (runnerTimeoutMs / MS_PER_SECOND).toFixed(1);
  const usedPercent = Math.floor(usedFraction * PERCENT);
  const summaryLine =
    `[run-node-tests] test:node used ${elapsedSeconds}s of its ${capSeconds}s ` +
    `whole-runner cap (${usedPercent}%).`;

  // DECIDE ON THE NUMBER WE PRINT (whitlockk review). Comparing the unrounded
  // fraction against the threshold let a run warn while still displaying "75%",
  // so the annotation contradicted the figure beside it. Both the display and
  // the decision now run off `usedPercent`, which makes the two impossible to
  // disagree: anything that warns shows 76% or more, anything showing 75% or
  // less stays silent. The cost is that the effective trip point is the next
  // whole percent (684.0s of a 900s cap, not 675.0s) — 9s later, against 200s+
  // of remaining margin, in exchange for telemetry that cannot lie.
  if (usedPercent <= DRIFT_WARN_PERCENT) {
    return { summaryLine, annotations: [] };
  }

  return {
    summaryLine,
    annotations: [
      "::warning title=desktop test:node is approaching its whole-runner cap::" +
        `test:node used ${elapsedSeconds}s of its ${capSeconds}s cap ` +
        `(${usedPercent}%), past the ${DRIFT_WARN_PERCENT}% drift threshold. ` +
        "The cap KILLS the run, so a lane that reaches it goes red — on a PR and " +
        "on the Desktop release. Shorten the suite (start with its slowest files) " +
        "or re-derive the cap from current per-lane runtime; do not raise it " +
        "reflexively.",
    ],
  };
}
