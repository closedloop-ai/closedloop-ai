import { describe, expect, it } from "vitest";
import {
  classifyRunnerOutcome,
  RunnerOutcomeKind,
} from "../scripts/run-node-tests-outcome.mjs";

const RUNNER_TIMEOUT_MS = 900_000;
const KILLED_VIA_PATTERN = /killed via/;
const ELAPSED_WITHOUT_SIGNAL_PATTERN = /\(elapsed 900000ms\) and was killed\./;

describe("classifyRunnerOutcome fallbacks", () => {
  it("an ETIMEDOUT with no signal names the elapsed time and no kill signal", () => {
    const outcome = classifyRunnerOutcome({
      error: { code: "ETIMEDOUT", message: "spawnSync node ETIMEDOUT" },
      signal: null,
      status: null,
      elapsedMs: RUNNER_TIMEOUT_MS,
      runnerTimeoutMs: RUNNER_TIMEOUT_MS,
    });

    expect(outcome.kind).toBe(RunnerOutcomeKind.TimedOut);
    expect(outcome.messages[0]).toMatch(ELAPSED_WITHOUT_SIGNAL_PATTERN);
    expect(outcome.messages[0]).not.toMatch(KILLED_VIA_PATTERN);
  });

  it("a launch error without a message falls back to String(error)", () => {
    // Pins current behavior; looks odd because a message-less plain object
    // renders as "[object Object]", which names nothing about the failure.
    const outcome = classifyRunnerOutcome({
      error: { code: "EACCES" },
      signal: null,
      status: null,
      elapsedMs: 10,
      runnerTimeoutMs: RUNNER_TIMEOUT_MS,
    });

    expect(outcome.kind).toBe(RunnerOutcomeKind.LaunchFailed);
    expect(outcome.messages).toEqual([
      "[run-node-tests] failed to launch test runner",
      "[object Object]",
    ]);
    expect(outcome.exitCode).toBe(1);
  });

  it("a completed run with no exit status fails with exit code 1", () => {
    const outcome = classifyRunnerOutcome({
      error: undefined,
      signal: null,
      status: null,
      elapsedMs: 10,
      runnerTimeoutMs: RUNNER_TIMEOUT_MS,
    });

    expect(outcome.kind).toBe(RunnerOutcomeKind.Completed);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.messages).toEqual([]);
  });
});
