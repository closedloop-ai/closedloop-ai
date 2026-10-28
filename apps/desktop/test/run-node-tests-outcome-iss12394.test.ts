/**
 * ISS-12394 — branch coverage for `scripts/run-node-tests-outcome.mjs`.
 *
 * Each case drives `classifyRunnerOutcome` or `appendStepSummary` through one
 * branch and asserts what that branch produces. The calls run in a plain Node
 * child, not in the Vitest worker: the node lane's c8 only credits code that
 * runs outside a Vite-transformed worker.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DRIFT_WARN_PERCENT,
  RunnerOutcomeKind,
} from "../scripts/run-node-tests-outcome.mjs";
import {
  CHILD_CASE_TIMEOUT_MS,
  runModuleInChild,
} from "./support/module-child";

const MODULE_URL = new URL(
  "../scripts/run-node-tests-outcome.mjs",
  import.meta.url
).href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const CAP_MS = 100_000;
const KILLED_VIA_PATTERN = /killed via/;
const WARNING_PATTERN = /^::warning /;

type Outcome = {
  kind: string;
  messages: string[];
  exitCode: number;
  summaryLine: string;
  annotations: string[];
};

type OutcomeInput = {
  error?: { code?: string; message?: string };
  signal?: string | null;
  status?: number | null;
  elapsedMs: number;
};

function runInChild<T>(body: string, prelude = ""): T {
  return runModuleInChild<T>({
    body,
    cwd: DESKTOP_DIR,
    moduleUrl: MODULE_URL,
    prelude,
  });
}

/** `classifyRunnerOutcome` over each input, in one child. */
function classify(inputs: OutcomeInput[]): Outcome[] {
  return runInChild<Outcome[]>(
    `out(${JSON.stringify(inputs)}.map((input) => m.classifyRunnerOutcome({ ...input, runnerTimeoutMs: ${CAP_MS} })));`
  );
}

describe("classifyRunnerOutcome timeout detection", () => {
  it(
    "names a timeout from ETIMEDOUT alone, with no signal clause",
    () => {
      const [outcome] = classify([
        {
          error: { code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" },
          signal: null,
          status: null,
          elapsedMs: 10,
        },
      ]);
      expect(outcome.kind).toBe(RunnerOutcomeKind.TimedOut);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.annotations).toEqual([]);
      expect(outcome.messages[0]).toContain("elapsed 10ms)");
      expect(outcome.messages[0]).not.toMatch(KILLED_VIA_PATTERN);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "names a timeout from a signal at the cap, and drops the drift warning",
    () => {
      const [outcome] = classify([
        { signal: "SIGTERM", status: null, elapsedMs: CAP_MS },
      ]);
      expect(outcome.kind).toBe(RunnerOutcomeKind.TimedOut);
      expect(outcome.messages[0]).toContain(
        `elapsed ${CAP_MS}ms, killed via SIGTERM`
      );
      expect(outcome.annotations).toEqual([]);
      expect(outcome.summaryLine).toContain("(100%)");
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "reports a signal before the cap as signaled, keeping the drift warning",
    () => {
      const [outcome] = classify([
        { signal: "SIGKILL", status: null, elapsedMs: CAP_MS - 1 },
      ]);
      expect(outcome.kind).toBe(RunnerOutcomeKind.Signaled);
      expect(outcome.messages).toEqual([
        "[run-node-tests] test runner exited via SIGKILL",
      ]);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.annotations).toHaveLength(1);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "does not treat an empty-string signal at the cap as a timeout",
    () => {
      const [outcome] = classify([
        { signal: "", status: 0, elapsedMs: CAP_MS },
      ]);
      expect(outcome.kind).toBe(RunnerOutcomeKind.Completed);
      expect(outcome.exitCode).toBe(0);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("classifyRunnerOutcome launch failure", () => {
  it(
    "prints the message of a non-timeout error",
    () => {
      const [outcome] = classify([
        {
          error: { code: "ENOENT", message: "spawn tsx ENOENT" },
          signal: null,
          status: null,
          elapsedMs: 0,
        },
      ]);
      expect(outcome.kind).toBe(RunnerOutcomeKind.LaunchFailed);
      expect(outcome.messages).toEqual([
        "[run-node-tests] failed to launch test runner",
        "spawn tsx ENOENT",
      ]);
      expect(outcome.exitCode).toBe(1);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "stringifies an error that carries no message",
    () => {
      const [outcome] = classify([
        { error: { code: "EACCES" }, signal: null, status: null, elapsedMs: 0 },
      ]);
      // pins current behavior; looks odd because a plain object stringifies
      // to "[object Object]", which tells the operator nothing.
      expect(outcome.messages[1]).toBe("[object Object]");
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "keeps the drift warning on a launch failure past the threshold",
    () => {
      const [outcome] = classify([
        {
          error: { message: "boom" },
          signal: null,
          status: null,
          elapsedMs: 90_000,
        },
      ]);
      expect(outcome.kind).toBe(RunnerOutcomeKind.LaunchFailed);
      expect(outcome.annotations).toHaveLength(1);
      expect(outcome.annotations[0]).toMatch(WARNING_PATTERN);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("classifyRunnerOutcome completed runs", () => {
  it(
    "passes the child's status through and fails a missing one",
    () => {
      const outcomes = classify([
        { signal: null, status: 3, elapsedMs: 1000 },
        { signal: null, status: null, elapsedMs: 1000 },
        { signal: null, elapsedMs: 1000 },
      ]);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        RunnerOutcomeKind.Completed,
        RunnerOutcomeKind.Completed,
        RunnerOutcomeKind.Completed,
      ]);
      expect(outcomes.map((outcome) => outcome.exitCode)).toEqual([3, 1, 1]);
      expect(outcomes[0].messages).toEqual([]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "stays quiet at the drift threshold and warns one percent past it",
    () => {
      const [atLine, pastLine] = classify([
        { signal: null, status: 0, elapsedMs: DRIFT_WARN_PERCENT * 1000 },
        {
          signal: null,
          status: 0,
          elapsedMs: (DRIFT_WARN_PERCENT + 1) * 1000,
        },
      ]);
      expect(atLine.annotations).toEqual([]);
      expect(atLine.summaryLine).toBe(
        "[run-node-tests] test:node used 75.0s of its 100.0s whole-runner cap (75%)."
      );
      expect(pastLine.annotations).toHaveLength(1);
      expect(pastLine.annotations[0]).toContain(
        "test:node used 76.0s of its 100.0s cap (76%), past the 75% drift threshold."
      );
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("appendStepSummary", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-node-tests-outcome-iss12394-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it(
    "never calls appendFileSync when GITHUB_STEP_SUMMARY is unset or empty",
    () => {
      const target = join(dir, "summary.md");
      // Counts appendFileSync calls by patching the builtin before the module
      // binds its named import.
      const calls = runInChild<number[]>(
        `const counts = [];
        m.appendStepSummary("line", {}); counts.push(appendCalls);
        m.appendStepSummary("line", { GITHUB_STEP_SUMMARY: "" }); counts.push(appendCalls);
        m.appendStepSummary("line", { GITHUB_STEP_SUMMARY: ${JSON.stringify(target)} }); counts.push(appendCalls);
        out(counts);`,
        `import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        let appendCalls = 0;
        const realAppend = fs.appendFileSync;
        fs.appendFileSync = (...args) => { appendCalls += 1; return realAppend(...args); };
        syncBuiltinESMExports();`
      );
      expect(calls).toEqual([0, 0, 1]);
      expect(existsSync(target)).toBe(true);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "appends one line per call to the summary file",
    () => {
      const target = join(dir, "summary.md");
      runInChild(
        `const env = { GITHUB_STEP_SUMMARY: ${JSON.stringify(target)} }; m.appendStepSummary("first", env); m.appendStepSummary("second", env); out(null);`
      );
      expect(readFileSync(target, "utf8")).toBe("first\nsecond\n");
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "swallows a write failure instead of throwing",
    () => {
      // A directory cannot be appended to, so appendFileSync throws EISDIR.
      const threw = runInChild<boolean>(
        `try { m.appendStepSummary("line", { GITHUB_STEP_SUMMARY: ${JSON.stringify(dir)} }); out(false); } catch { out(true); }`
      );
      expect(threw).toBe(false);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
