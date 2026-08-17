/**
 * ISS-5256 — the desktop `test:node` whole-runner cap must report its own
 * headroom on every run.
 *
 * The cap killed the Desktop v0.16.1087 release on 2026-08-05. It behaved
 * correctly; the problem was that its margin had shrunk to 1.21x on the slowest
 * lane and nothing said so until a release died. These tests pin the replacement
 * signal: a headroom line on EVERY outcome, and a warning annotation only once a
 * run crosses `DRIFT_WARN_PERCENT` — early enough to act, quiet enough to mean
 * something.
 *
 * The threshold cases drive `classifyRunnerOutcome`, the function the runner
 * calls. The final two drive `run-node-tests.mjs` itself, as subprocesses, so
 * that deleting any part of the emission at the production call site — the
 * `console.log`, the annotation loop, or the `appendStepSummary` call — fails
 * here rather than silently un-reporting the drift these tests exist to surface.
 * One covers the healthy path (summary line, step-summary row, shipped cap); the
 * other shrinks the cap so the same run crosses the threshold and the annotation
 * loop actually executes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendStepSummary,
  classifyRunnerOutcome,
  DEFAULT_RUNNER_TIMEOUT_MS,
  DRIFT_WARN_PERCENT,
  RunnerOutcomeKind,
} from "../scripts/run-node-tests-outcome.mjs";

// The PRODUCTION cap, not a copy of it. Every threshold case below is stated in
// real seconds against this value, so reverting the ISS-5256 raise (900s → the
// old 720s) moves the boundary under the measured lane runtimes and reddens this
// file — which is the point. A local `15 * 60_000` literal would not.
const RUNNER_TIMEOUT_MS = DEFAULT_RUNNER_TIMEOUT_MS;
const DRIFT_WARNING_PATTERN =
  /^::warning title=desktop test:node is approaching its whole-runner cap::/;
const HEADROOM_LINE_PATTERN =
  /\[run-node-tests] test:node used [\d.]+s of its [\d.]+s whole-runner cap \(\d+%\)\./;
const OVERRIDE_HINT_PATTERN = /NODE_TEST_RUNNER_TIMEOUT_MS/;
const WHOLE_RUNNER_CAP_PATTERN = /whole-runner cap/;
const HEALTHY_ELAPSED_PATTERN = /507\.0s of its 900\.0s/;
const HEALTHY_PERCENT_PATTERN = /\(56%\)/;
const DRIFTED_ELAPSED_PATTERN = /810\.0s of its 900\.0s cap \(90%\)/;
const DRIFT_THRESHOLD_PATTERN = /past the 75% drift threshold\./;
const NO_REFLEXIVE_RAISE_PATTERN = /do not raise it reflexively/;
const CAP_FULLY_CONSUMED_PATTERN = /\(100%\)/;
const AT_THRESHOLD_PERCENT_PATTERN = /\(75%\)/;
const FIRST_WARNING_PERCENT_PATTERN = /\(76%\)/;
const PRODUCTION_CAP_PATTERN = /of its 900\.0s whole-runner cap/;
const DRIFT_WARNING_ANYWHERE_PATTERN =
  /::warning title=desktop test:node is approaching its whole-runner cap::/;
const PERCENT = 100;

/**
 * The boundary, in the unit the decision is made in. The runner warns when the
 * DISPLAYED whole percent exceeds `DRIFT_WARN_PERCENT`, so the last silent run is
 * the largest one that still displays 75% and the first warning run is the
 * smallest that displays 76%. Deriving both from the exported constant means the
 * pair moves with the policy instead of drifting from it.
 */
const LAST_SILENT_MS =
  Math.ceil((RUNNER_TIMEOUT_MS * (DRIFT_WARN_PERCENT + 1)) / PERCENT) - 1;
const FIRST_WARNING_MS = Math.ceil(
  (RUNNER_TIMEOUT_MS * (DRIFT_WARN_PERCENT + 1)) / PERCENT
);

test("a healthy run reports its headroom and raises no annotation", () => {
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: 507_000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.Completed);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.summaryLine, HEADROOM_LINE_PATTERN);
  assert.match(outcome.summaryLine, HEALTHY_ELAPSED_PATTERN);
  assert.match(outcome.summaryLine, HEALTHY_PERCENT_PATTERN);
  assert.deepEqual(
    outcome.annotations,
    [],
    "a run with real headroom must stay quiet, or the annotation stops meaning anything"
  );
});

test("crossing the drift threshold raises exactly one warning annotation", () => {
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: FIRST_WARNING_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.annotations.length, 1);
  assert.match(outcome.annotations[0] ?? "", DRIFT_WARNING_PATTERN);
});

test("a run at the threshold does not warn", () => {
  // Boundary driven from the exported constant so the comparison itself is
  // pinned: removing it fails here immediately.
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: LAST_SILENT_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.deepEqual(outcome.annotations, []);
});

test("the printed percentage never contradicts the warn decision at the boundary", () => {
  // wongk review: the decision used to run off the unrounded fraction while the
  // human read a rounded percent, so a warning run and a silent run could both
  // print "75%". Both now derive from the same whole percent, which makes that
  // pair impossible — the silent side shows 75%, the warning side shows 76%.
  const lastSilent = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: LAST_SILENT_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });
  assert.match(lastSilent.summaryLine, AT_THRESHOLD_PERCENT_PATTERN);
  assert.deepEqual(lastSilent.annotations, []);

  const firstWarning = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: FIRST_WARNING_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });
  assert.match(firstWarning.summaryLine, FIRST_WARNING_PERCENT_PATTERN);
  assert.equal(firstWarning.annotations.length, 1);
  // The annotation must quote the same figure its own summary line shows.
  assert.match(
    firstWarning.annotations[0] ?? "",
    FIRST_WARNING_PERCENT_PATTERN
  );
  assert.match(firstWarning.annotations[0] ?? "", DRIFT_THRESHOLD_PATTERN);
});

test("the threshold sits above real runtime and below a genuinely drifted suite", () => {
  // Pins the POLICY, not just the comparison. Driving the boundary off
  // DRIFT_WARN_PERCENT alone would let a future 90 keep those tests green
  // while the warning moved past the point where it is still actionable, so
  // these two cases are stated in measured seconds instead:
  //
  //   596s — above every `test:node` run measured on either unsharded lane
  //          (ISS-5969: linux_4_core_arm max 314.2s, macos-latest max green
  //          510.4s). Real runtime must stay QUIET.
  //   700s — ~100s of growth on top of that. Must WARN, with the cap still
  //          200s away, i.e. while there is room to act rather than at the cliff.
  const aboveEveryMeasuredRun = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: 596_000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });
  assert.deepEqual(
    aboveEveryMeasuredRun.annotations,
    [],
    "the threshold must not fire on runtime the suite already has, or it is noise from day one"
  );

  const drifted = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: 700_000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });
  assert.equal(
    drifted.annotations.length,
    1,
    "real drift must be reported while the cap is still ~200s away"
  );
});

test("the drift warning names the cap and refuses to recommend raising it", () => {
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: 810_000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  const annotation = outcome.annotations[0] ?? "";
  assert.match(annotation, DRIFTED_ELAPSED_PATTERN);
  assert.match(annotation, DRIFT_THRESHOLD_PATTERN);
  assert.match(annotation, NO_REFLEXIVE_RAISE_PATTERN);
});

test("a failing run still reports headroom and keeps its exit code", () => {
  // Red AND near the cap is the state most worth seeing: the next slow run is a
  // kill, not a failure with a name attached.
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 1,
    elapsedMs: FIRST_WARNING_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.summaryLine, HEADROOM_LINE_PATTERN);
  assert.equal(outcome.annotations.length, 1);
});

test("an early signal still reports headroom", () => {
  // The signaled branch composes the same headroom record; without it the runner
  // would print `undefined` while reporting a real signal.
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: "SIGKILL",
    status: null,
    elapsedMs: 1000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.Signaled);
  assert.match(outcome.summaryLine, HEADROOM_LINE_PATTERN);
  assert.deepEqual(outcome.annotations, []);
});

test("a launch failure still reports headroom", () => {
  const outcome = classifyRunnerOutcome({
    error: { code: "ENOENT", message: "spawnSync pnpm ENOENT" },
    signal: null,
    status: null,
    elapsedMs: 12,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.LaunchFailed);
  assert.match(outcome.summaryLine, HEADROOM_LINE_PATTERN);
  assert.deepEqual(outcome.annotations, []);
});

test("the step-summary row is appended, not overwritten, when GitHub names a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-node-tests-summary-"));
  try {
    const summaryPath = join(dir, "summary.md");
    const env: NodeJS.ProcessEnv = { GITHUB_STEP_SUMMARY: summaryPath };

    appendStepSummary("first run", env);
    appendStepSummary("second run", env);

    // Append, not truncate: the step summary is shared with every other step
    // that writes to it, so a clobbering write would eat their content too.
    assert.equal(readFileSync(summaryPath, "utf8"), "first run\nsecond run\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a summary-file failure is swallowed rather than failing the suite", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-node-tests-summary-"));
  try {
    // A directory is not an appendable file, so the write really throws EISDIR
    // here — no mock stands in for the failure this must absorb. This runner's
    // exit code is the merge-queue and Desktop-release verdict; telemetry must
    // never be able to move it.
    assert.doesNotThrow(() =>
      appendStepSummary("dropped", { GITHUB_STEP_SUMMARY: dir })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no summary file is written when GitHub did not name one", () => {
  // The local and Dagger paths run without GITHUB_STEP_SUMMARY; passing an
  // explicit env keeps this test off the ambient host environment (ISS-5114).
  assert.doesNotThrow(() => appendStepSummary("local run", {}));
});

test("a timeout reports 100% headroom used and adds no redundant warning", () => {
  const outcome = classifyRunnerOutcome({
    error: { code: "ETIMEDOUT", message: "spawnSync pnpm ETIMEDOUT" },
    signal: "SIGTERM",
    status: null,
    elapsedMs: RUNNER_TIMEOUT_MS + 301,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.TimedOut);
  assert.match(outcome.summaryLine, CAP_FULLY_CONSUMED_PATTERN);
  assert.deepEqual(
    outcome.annotations,
    [],
    "'you are near the cap' on top of 'you hit the cap' is noise"
  );
  // ISS-5114 regression guard: the timeout's own diagnostics must survive.
  const report = outcome.messages.join("\n");
  assert.match(report, WHOLE_RUNNER_CAP_PATTERN);
  assert.match(report, OVERRIDE_HINT_PATTERN);
});

test("the runner itself emits the headroom line and the step-summary row", {
  timeout: 60_000,
}, () => {
  // The one case that exercises the PRODUCTION entrypoint rather than its
  // helpers: without it, deleting `console.log(outcome.summaryLine)` or the
  // `appendStepSummary(...)` call would leave every other test in this file
  // green while the lane went silent again.
  //
  // The runner is a top-level script that runs the whole suite on import, so it
  // can only be reached as a subprocess — and it must be reached WITHOUT letting
  // it start that suite. An empty PATH does exactly that: the runner's inner
  // `spawnSync("pnpm", …)` fails ENOENT before any test process exists, and the
  // reporting path under test runs identically on that branch.
  //
  // Capping the runner instead (NODE_TEST_RUNNER_TIMEOUT_MS=1) does NOT work and
  // must not be reintroduced: `spawnSync`'s timeout kills the direct child
  // (`pnpm`), while the `tsx --test` grandchild it already forked survives as an
  // orphan holding this test's inherited stdio — measured running the entire
  // 7,600-test desktop suite a second time, in the background, on every run.
  const dir = mkdtempSync(join(tmpdir(), "run-node-tests-e2e-"));
  try {
    const summaryPath = join(dir, "summary.md");
    const runnerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "run-node-tests.mjs"
    );

    // A child deadline as well. node:test's `timeout` above is a timer on this
    // worker's event loop, and `spawnSync` blocks that loop until the child
    // exits, so the declared timeout cannot interrupt it — the repo pins exactly
    // that behavior in scripts/deploy/sync-spawn-deadline.test.ts.
    //
    // NODE_TEST_RUNNER_TIMEOUT_MS is stripped, not inherited (wongk review): an
    // operator with it exported would otherwise choose the cap this asserts,
    // making the DEFAULT_RUNNER_TIMEOUT_MS wiring below unpinned on their machine.
    const result = spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        ...runnerEnvWithoutOverride(),
        GITHUB_STEP_SUMMARY: summaryPath,
        PATH: dir,
      },
    });

    assert.equal(
      result.error,
      undefined,
      `runner did not exit on its own: ${result.error?.message ?? ""}`
    );
    assert.match(
      result.stdout,
      HEADROOM_LINE_PATTERN,
      "the runner must print its elapsed-vs-cap line on stdout"
    );
    assert.match(
      readFileSync(summaryPath, "utf8"),
      HEADROOM_LINE_PATTERN,
      "the runner must append the same line to $GITHUB_STEP_SUMMARY"
    );
    // The cap the entrypoint actually shipped, not just "some cap" (wongk
    // review): wiring the default back to 720s would print `720.0s` here.
    assert.match(
      result.stdout,
      PRODUCTION_CAP_PATTERN,
      "the runner must run on DEFAULT_RUNNER_TIMEOUT_MS when nothing overrides it"
    );
    // A run that could not launch its tests is a failed run: the verdict must
    // still be non-zero, so switching to `process.exitCode` must not have
    // dropped it — and the telemetry above must not have masked it.
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the runner itself emits the drift annotation once it crosses the threshold", {
  timeout: 60_000,
}, () => {
  // The sibling case above always lands at ~0% of a 900s cap, so it can never
  // reach the annotation loop — deleting that loop would leave it green (wongk
  // review). Shrinking the cap to 1ms puts the same launch-failure run far past
  // the threshold, so the loop runs for real. PATH is still empty, so no suite
  // starts and no orphan is possible.
  const dir = mkdtempSync(join(tmpdir(), "run-node-tests-warn-"));
  try {
    const runnerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "run-node-tests.mjs"
    );

    const result = spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        ...runnerEnvWithoutOverride(),
        NODE_TEST_RUNNER_TIMEOUT_MS: "1",
        PATH: dir,
      },
    });

    assert.equal(
      result.error,
      undefined,
      `runner did not exit on its own: ${result.error?.message ?? ""}`
    );
    assert.match(
      result.stdout,
      DRIFT_WARNING_ANYWHERE_PATTERN,
      "the runner must print the ::warning:: annotation, not just compute it"
    );
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The ambient environment minus the one variable that would let an operator's
 * shell decide which cap these subprocess cases observe.
 */
function runnerEnvWithoutOverride(): NodeJS.ProcessEnv {
  const { NODE_TEST_RUNNER_TIMEOUT_MS: _ignored, ...rest } = process.env;
  return rest;
}
