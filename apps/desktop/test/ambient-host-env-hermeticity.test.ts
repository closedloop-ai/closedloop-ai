/**
 * ISS-5114 regression coverage — the desktop suite must not read its result off
 * the ambient host environment.
 *
 * Two independent defects, covered here in the same order the ticket names them.
 *
 * 1. THE COUPLING. Claude Code exports `CLAUDE_CODE_ENABLE_TELEMETRY=1` into the
 *    shell it spawns agents in, and `claude` itself is installed at an absolute
 *    known location. Tests asserting those are ABSENT inherited that precondition
 *    from the host instead of establishing it, so they failed for every developer
 *    running Claude Code and passed in CI only because CI happens to lack both.
 *
 * 2. THE PROPAGATION. When the whole-runner wall-clock cap fired, the runner
 *    script reported it as "failed to launch test runner" and printed the entire
 *    ~600-entry argv, while the unrun tail appeared as a large `cancelled` count.
 *    The operator saw "suite broken", not "one run hit its 12-minute cap".
 *
 * Both are exercised against the real production helpers, with an explicit env
 * object where possible so this file does not itself become host-coupled.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRunnerOutcome,
  RunnerOutcomeKind,
} from "../scripts/run-node-tests-outcome.mjs";
import { ClaudeCodeOtelEnvVar } from "../src/server/otel/claude-code-env.js";
import {
  omitClaudeCodeOtelEnv,
  stripAmbientClaudeCodeOtelEnv,
} from "./helpers/ambient-otel-env.js";

const OTEL_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);
const RUNNER_TIMEOUT_MS = 12 * 60_000;
const WHOLE_RUNNER_CAP_PATTERN = /whole-runner cap/;
const LAUNCH_FAILURE_PATTERN = /failed to launch/;
const CANCELLED_EXPLANATION_PATTERN = /cancelled/;
const LAUNCH_FAILURE_REPORT_PATTERN = /failed to launch test runner/;
const SIGKILL_REPORT_PATTERN = /exited via SIGKILL/;

test("omitClaudeCodeOtelEnv strips every OTel key and keeps the rest", () => {
  const source: NodeJS.ProcessEnv = {
    [ClaudeCodeOtelEnvVar.EnableTelemetry]: "1",
    [ClaudeCodeOtelEnvVar.MetricsExporter]: "otlp",
    [ClaudeCodeOtelEnvVar.LogsExporter]: "otlp",
    [ClaudeCodeOtelEnvVar.OtlpProtocol]: "http/protobuf",
    [ClaudeCodeOtelEnvVar.OtlpEndpoint]: "http://127.0.0.1:4318",
    PATH: "/usr/bin",
  };

  const cleaned = omitClaudeCodeOtelEnv(source);

  for (const key of OTEL_ENV_KEYS) {
    assert.equal(Object.hasOwn(cleaned, key), false, `${key} must be removed`);
  }
  assert.equal(cleaned.PATH, "/usr/bin");
  // The source object is the caller's — it must not be mutated.
  assert.equal(source[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
});

test("stripAmbientClaudeCodeOtelEnv removes a set var and restores its value", () => {
  const key = ClaudeCodeOtelEnvVar.EnableTelemetry;
  const preexisting = process.env[key];
  try {
    // Reproduce the exact host condition Claude Code creates.
    process.env[key] = "1";

    const restore = stripAmbientClaudeCodeOtelEnv();
    assert.equal(
      process.env[key],
      undefined,
      "the var must be gone, not blank"
    );
    assert.equal(Object.hasOwn(process.env, key), false);

    restore();
    assert.equal(process.env[key], "1", "the exact prior value must come back");
  } finally {
    // A failing assertion above must not leave this process dirtier than it
    // started — that would be the very coupling this file exists to remove.
    restoreEnvVar(key, preexisting);
  }
});

test("stripAmbientClaudeCodeOtelEnv restores an originally-unset var as ABSENT", () => {
  const key = ClaudeCodeOtelEnvVar.OtlpEndpoint;
  const preexisting = process.env[key];
  try {
    Reflect.deleteProperty(process.env, key);

    const restore = stripAmbientClaudeCodeOtelEnv();
    restore();

    // The repo rule this pins: assigning `undefined` to a process.env key
    // stores the STRING "undefined", which would leave the host dirtier than
    // it started.
    assert.equal(Object.hasOwn(process.env, key), false);
    assert.notEqual(process.env[key], "undefined");
  } finally {
    restoreEnvVar(key, preexisting);
  }
});

test("a whole-runner timeout is reported as a timeout, not a launch failure", () => {
  // The exact shape Node produces: spawnSync's timeout sets BOTH an ETIMEDOUT
  // error and a SIGTERM signal, which is how the old error-first branch
  // swallowed it.
  const outcome = classifyRunnerOutcome({
    error: { code: "ETIMEDOUT", message: "spawnSync pnpm ETIMEDOUT" },
    signal: "SIGTERM",
    status: null,
    elapsedMs: RUNNER_TIMEOUT_MS,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.TimedOut);
  assert.equal(outcome.exitCode, 1);
  const report = outcome.messages.join("\n");
  assert.match(report, WHOLE_RUNNER_CAP_PATTERN);
  assert.doesNotMatch(
    report,
    LAUNCH_FAILURE_PATTERN,
    "a timeout must never be described as a launch failure"
  );
  assert.match(
    report,
    CANCELLED_EXPLANATION_PATTERN,
    "the report must say what the cancelled tail means"
  );
});

test("a SIGTERM at the cap is a timeout even without an ETIMEDOUT error", () => {
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: "SIGTERM",
    status: null,
    elapsedMs: RUNNER_TIMEOUT_MS + 5,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.TimedOut);
});

test("a genuine launch failure is still reported as a launch failure", () => {
  const outcome = classifyRunnerOutcome({
    error: { code: "ENOENT", message: "spawnSync pnpm ENOENT" },
    signal: null,
    status: null,
    elapsedMs: 12,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.LaunchFailed);
  assert.match(outcome.messages.join("\n"), LAUNCH_FAILURE_REPORT_PATTERN);
  assert.equal(outcome.exitCode, 1);
});

test("an early signal that is not the cap is reported as a signal", () => {
  const outcome = classifyRunnerOutcome({
    error: undefined,
    signal: "SIGKILL",
    status: null,
    elapsedMs: 1000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });

  assert.equal(outcome.kind, RunnerOutcomeKind.Signaled);
  assert.match(outcome.messages.join("\n"), SIGKILL_REPORT_PATTERN);
});

test("a clean run forwards the child's exit status and prints nothing", () => {
  const passing = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 0,
    elapsedMs: 1000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });
  assert.equal(passing.kind, RunnerOutcomeKind.Completed);
  assert.equal(passing.exitCode, 0);
  assert.deepEqual(passing.messages, []);

  const failing = classifyRunnerOutcome({
    error: undefined,
    signal: null,
    status: 1,
    elapsedMs: 1000,
    runnerTimeoutMs: RUNNER_TIMEOUT_MS,
  });
  assert.equal(failing.exitCode, 1);
});

/**
 * Put one `process.env` key back to `priorValue`, removing it entirely when it
 * was originally unset — assigning `undefined` would store the string
 * "undefined" (AGENTS.md → Test Practices).
 */
function restoreEnvVar(key: string, priorValue: string | undefined): void {
  if (priorValue === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = priorValue;
}
