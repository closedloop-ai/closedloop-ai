/**
 * Tests for the JSONL fallback path in resolveEffectiveState() from
 * symphony-status.ts.
 *
 * resolveEffectiveState() is not exported directly. When a dead PID is
 * detected and state.json reports IN_PROGRESS, it calls detectSuccessFromOutput()
 * from token-usage.ts and maps the outcome:
 *
 *   outcome "success"    → status COMPLETED, fallbackDetected true
 *   outcome "missing"    → status STOPPED,   fallbackDetected false
 *   outcome "unreadable" → status STOPPED,   fallbackDetected false
 *   outcome "no-success" → status STOPPED,   fallbackDetected false
 *
 * detectSuccessFromOutput() has no Electron dependency and can be imported and
 * tested directly. Every DetectSuccessOutcome variant is exercised: the
 * data-driven cases below cover "success", "missing", and "no-success" (the
 * latter twice — once from a non-success record, once from malformed JSONL
 * that all parse-fails and is skipped). The dedicated permission-denied test
 * below the loop covers "unreadable" by chmodding the JSONL file itself to
 * 0o000 so readFileSync throws EACCES while the parent directory remains
 * traversable (chmodding the parent to 0o000 would instead make existsSync
 * return false and route through the "missing" branch).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import {
  type DetectSuccessOutcome,
  detectSuccessFromOutput,
} from "../src/main/token-usage.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const { makeTempDir } = createTempDirManager("symphony-status-test-");

/**
 * Map a detectSuccessFromOutput outcome to the effective status/fallbackDetected
 * pair that resolveEffectiveState would return when a dead PID is present and
 * state.json contains IN_PROGRESS.
 *
 * This mirrors the logic at symphony-status.ts resolveEffectiveState() lines
 * that handle the `pid !== null && !processRunning` branch.
 */
function mapOutcomeToEffectiveState(outcome: DetectSuccessOutcome): {
  status: string;
  fallbackDetected: boolean;
} {
  if (outcome.outcome === "success") {
    return { status: "COMPLETED", fallbackDetected: true };
  }
  return { status: "STOPPED", fallbackDetected: false };
}

// ---------------------------------------------------------------------------
// JSONL fallback path: dead PID + IN_PROGRESS state
// ---------------------------------------------------------------------------

type FallbackCase = {
  readonly name: string;
  readonly jsonlContent: string | null;
  readonly expected: {
    readonly outcome: DetectSuccessOutcome["outcome"];
    readonly status: string;
    readonly fallbackDetected: boolean;
  };
};

const fallbackCases: readonly FallbackCase[] = [
  {
    name: "success record in JSONL returns COMPLETED",
    jsonlContent: `${JSON.stringify({ type: "result", subtype: "success" })}\n`,
    expected: {
      outcome: "success",
      status: "COMPLETED",
      fallbackDetected: true,
    },
  },
  {
    name: "no success record in JSONL returns STOPPED",
    jsonlContent:
      JSON.stringify({ type: "result", subtype: "error_during_execution" }) +
      "\n",
    expected: {
      outcome: "no-success",
      status: "STOPPED",
      fallbackDetected: false,
    },
  },
  {
    name: "missing JSONL file returns STOPPED",
    jsonlContent: null,
    expected: {
      outcome: "missing",
      status: "STOPPED",
      fallbackDetected: false,
    },
  },
  // Malformed lines parse-fail and are skipped → "no-success" (not "unreadable",
  // which requires the file itself to be unreadable at the OS level).
  {
    name: "malformed JSONL returns STOPPED",
    jsonlContent: "not-json\n{broken: json\n{{{\n",
    expected: {
      outcome: "no-success",
      status: "STOPPED",
      fallbackDetected: false,
    },
  },
];

describe("resolveEffectiveState JSONL fallback — dead PID + IN_PROGRESS state", () => {
  for (const fixture of fallbackCases) {
    test(`dead PID + ${fixture.name}`, async () => {
      const claudeWorkDir = path.join(makeTempDir(), ".closedloop-ai", "work");
      await fs.mkdir(claudeWorkDir, { recursive: true });
      if (fixture.jsonlContent !== null) {
        await fs.writeFile(
          path.join(claudeWorkDir, "claude-output.jsonl"),
          fixture.jsonlContent
        );
      }

      const outcome = detectSuccessFromOutput(claudeWorkDir);
      const effective = mapOutcomeToEffectiveState(outcome);

      assert.equal(outcome.outcome, fixture.expected.outcome);
      assert.equal(effective.status, fixture.expected.status);
      assert.equal(
        effective.fallbackDetected,
        fixture.expected.fallbackDetected
      );
    });
  }

  test("dead PID + unreadable JSONL file returns STOPPED", async () => {
    // Force a filesystem read error by stripping all permissions on the JSONL
    // file. Chmodding the parent directory instead would block path traversal,
    // making existsSync() return false and routing through the "missing"
    // branch — the only way to exercise the "unreadable" branch in
    // detectSuccessFromOutput is for the file to be resolvable but unreadable.
    const claudeWorkDir = path.join(makeTempDir(), ".closedloop-ai", "work");
    await fs.mkdir(claudeWorkDir, { recursive: true });
    const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
    await fs.writeFile(
      jsonlPath,
      `${JSON.stringify({ type: "result", subtype: "success" })}\n`
    );
    await fs.chmod(jsonlPath, 0o000);

    try {
      const outcome = detectSuccessFromOutput(claudeWorkDir);
      const effective = mapOutcomeToEffectiveState(outcome);

      // Writing a valid success record before the chmod makes the assertion
      // unambiguous: the only reason outcome is not "success" is the read
      // failure, proving we exercised the "unreadable" branch. outcome.error
      // is intentionally not asserted because the underlying err.message
      // varies by platform/libuv version and is not part of the contract.
      assert.equal(outcome.outcome, "unreadable");
      assert.equal(effective.status, "STOPPED");
      assert.equal(effective.fallbackDetected, false);
    } finally {
      // Restore read+write so the afterEach rm can remove the temp tree on
      // platforms where unlink of a 0o000-mode file requires extra steps.
      await fs.chmod(jsonlPath, 0o600);
    }
  });
});
