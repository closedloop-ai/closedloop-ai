import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import {
  CheckSeverity,
  HealthCheckRepairAction,
} from "@closedloop-ai/loops-api/compute-target";
import {
  BLOCKED_ERROR_MESSAGE,
  CLAUDE_CLI_CHECK_ID,
} from "../src/server/operations/health-check-blocked.js";
import { annotateRepairability } from "../src/server/operations/health-check-repairability.js";
import type { GatewayCheckResult as CheckResult } from "../src/server/operations/health-check-types.js";
import {
  PLUGIN_LIST_COMMAND_FAILED_ERROR,
  PLUGIN_LIST_UNREADABLE_ERROR,
  PLUGIN_STATE_UNVERIFIED_ERROR,
} from "../src/server/operations/health-check-types.js";

/**
 * Per-row repairability, unit-tested against synthetic rows (ISS-5389 review).
 *
 * Both cases here are ones the integration suite could not reach: they turn on
 * what a row looks like AFTER `applyPluginEnableChecks` has rewritten it, and on
 * whether the Claude CLI row is itself repairable.
 */

const PLUGIN_CHECK_ID = "plugin-code";
const RE_CANNOT_INSTALL = /cannot install a missing one/;
const RE_STATE_UNREADABLE = /enabled state could not be read/;
const RE_FIX_CLAUDE_FIRST = /Fix the Claude CLI row first/;
/** Never exists, so the override always reads as provably stale. */
const STALE_CLAUDE_PATH = path.join(
  path.sep,
  "nonexistent-closedloop-test",
  "bin",
  "claude"
);

function makeCheck(overrides: Partial<CheckResult> & { id: string }) {
  return {
    label: overrides.id,
    required: true,
    passed: false,
    ...overrides,
  } as CheckResult;
}

function findRepair(checks: CheckResult[], id: string) {
  return checks.find((check) => check.id === id)?.repair;
}

describe("annotateRepairability plugin rows", () => {
  test("keeps a plugin repairable after a failed enable rewrote its error", async () => {
    // `applyPluginEnableChecks` overwrites `error` with a display string when an
    // enable fails, but the plugin is still installed and a retry re-derives
    // "Disabled". Classifying off `error` called it missing and took the retry
    // control away.
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID, passed: true }),
        makeCheck({
          id: PLUGIN_CHECK_ID,
          error: "Automatic enable failed",
          enableAttempted: true,
          enableOutcome: "failed",
        }),
      ],
      undefined
    );

    assert.equal(findRepair(annotated, PLUGIN_CHECK_ID)?.repairable, true);
    assert.equal(
      findRepair(annotated, PLUGIN_CHECK_ID)?.action,
      HealthCheckRepairAction.EnablePlugins
    );
  });

  test("keeps a plugin repairable after an enable timed out", async () => {
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID, passed: true }),
        makeCheck({
          id: PLUGIN_CHECK_ID,
          error: "Enable timed out",
          enableAttempted: true,
          enableOutcome: "timeout",
        }),
      ],
      undefined
    );

    assert.equal(findRepair(annotated, PLUGIN_CHECK_ID)?.repairable, true);
  });

  test("still calls a genuinely missing plugin not installed", async () => {
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID, passed: true }),
        makeCheck({ id: PLUGIN_CHECK_ID, error: "Not found" }),
      ],
      undefined
    );
    const repair = findRepair(annotated, PLUGIN_CHECK_ID);

    assert.equal(repair?.repairable, false);
    assert.match(repair?.reason ?? "", RE_CANNOT_INSTALL);
  });

  test("does not call an installed-but-unverified plugin missing", async () => {
    // ISS-5810 split this into three strings by WHY the read failed. ALL of
    // them describe the same repair posture, so all of them must classify the
    // same way — one falling through would tell the user to install a plugin
    // that is already there, the exact ISS-5389 regression this guards.
    for (const error of [
      PLUGIN_STATE_UNVERIFIED_ERROR,
      PLUGIN_LIST_COMMAND_FAILED_ERROR,
      PLUGIN_LIST_UNREADABLE_ERROR,
    ]) {
      const annotated = await annotateRepairability(
        [
          makeCheck({ id: CLAUDE_CLI_CHECK_ID, passed: true }),
          makeCheck({ id: PLUGIN_CHECK_ID, error }),
        ],
        undefined
      );
      const repair = findRepair(annotated, PLUGIN_CHECK_ID);

      assert.equal(repair?.repairable, false, error);
      assert.match(repair?.reason ?? "", RE_STATE_UNREADABLE, error);
    }
  });

  test("withholds Repair when the enable ran and the VERIFICATION read failed", async () => {
    // Since the ISS-5810 review a row can carry both `enableAttempted` and an
    // unreadable-state error: the enable ran, then the read that would have
    // confirmed it did not. Offering Repair there re-runs `claude plugin
    // enable` against a plugin that may already be enabled — the command that
    // fails by design, i.e. the loop this work exists to break.
    for (const error of [
      PLUGIN_LIST_COMMAND_FAILED_ERROR,
      PLUGIN_LIST_UNREADABLE_ERROR,
    ]) {
      const annotated = await annotateRepairability(
        [
          makeCheck({ id: CLAUDE_CLI_CHECK_ID, passed: true }),
          makeCheck({
            id: PLUGIN_CHECK_ID,
            error,
            severity: CheckSeverity.Unknown,
            enableAttempted: true,
          }),
        ],
        undefined
      );
      const repair = findRepair(annotated, PLUGIN_CHECK_ID);

      assert.equal(repair?.repairable, false, error);
      assert.match(repair?.reason ?? "", RE_STATE_UNREADABLE, error);
    }
  });
});

describe("annotateRepairability plugin rows blocked by the Claude CLI", () => {
  test("offers Repair when the Claude CLI fault is itself repairable", async () => {
    // A stale override is cleared FIRST, inside the sweep that re-derives the
    // Claude CLI row, so the enable really can land in one press.
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID }),
        makeCheck({ id: PLUGIN_CHECK_ID, error: "Disabled" }),
      ],
      { claude: STALE_CLAUDE_PATH }
    );
    const repair = findRepair(annotated, PLUGIN_CHECK_ID);

    assert.equal(repair?.repairable, true);
    assert.equal(repair?.blockedByCheckId, CLAUDE_CLI_CHECK_ID);
  });

  test("withholds Repair when the Claude CLI fault cannot be repaired", async () => {
    // No override to clear, so nothing here fixes `claude`. Offering Repair
    // would only ever produce a skipped step.
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID, error: "Not found" }),
        makeCheck({ id: PLUGIN_CHECK_ID, error: "Disabled" }),
      ],
      undefined
    );
    const repair = findRepair(annotated, PLUGIN_CHECK_ID);

    assert.equal(repair?.repairable, false);
    assert.equal(repair?.blockedByCheckId, CLAUDE_CLI_CHECK_ID);
    assert.match(repair?.reason ?? "", RE_FIX_CLAUDE_FIRST);
  });

  test("offers Repair normally when the Claude CLI passes", async () => {
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID, passed: true }),
        makeCheck({ id: PLUGIN_CHECK_ID, error: "Disabled" }),
      ],
      undefined
    );
    const repair = findRepair(annotated, PLUGIN_CHECK_ID);

    assert.equal(repair?.repairable, true);
    assert.equal(repair?.blockedByCheckId, undefined);
  });

  // The rows above carry `error: "Disabled"`, which is NOT what the real
  // pipeline hands this module for a blocked plugin: `applyClaudeCliBlockedChecks`
  // runs first in the same sweep and REWRITES `error` to the blocked message
  // while stamping `severity` / `blockedBy`. Classifying off the rewritten
  // string sent these rows to "not installed" — telling the user to install a
  // plugin that is already there, and making the blocked branch below
  // unreachable in production (ISS-5389 review). These two pin the real shape.
  const blockedPluginRow = () =>
    makeCheck({
      id: PLUGIN_CHECK_ID,
      severity: CheckSeverity.Blocked,
      blockedBy: CLAUDE_CLI_CHECK_ID,
      error: BLOCKED_ERROR_MESSAGE,
    });

  test("names the Claude CLI for a BLOCKED plugin row it cannot repair", async () => {
    const annotated = await annotateRepairability(
      [
        makeCheck({ id: CLAUDE_CLI_CHECK_ID, error: "Not found" }),
        blockedPluginRow(),
      ],
      undefined
    );
    const repair = findRepair(annotated, PLUGIN_CHECK_ID);

    assert.equal(repair?.repairable, false);
    assert.equal(repair?.blockedByCheckId, CLAUDE_CLI_CHECK_ID);
    assert.match(repair?.reason ?? "", RE_FIX_CLAUDE_FIRST);
    // The regression itself: never claim an installed plugin is missing.
    assert.doesNotMatch(repair?.reason ?? "", RE_CANNOT_INSTALL);
  });

  test("offers Repair for a BLOCKED plugin row once the Claude CLI fault is repairable", async () => {
    const annotated = await annotateRepairability(
      [makeCheck({ id: CLAUDE_CLI_CHECK_ID }), blockedPluginRow()],
      { claude: STALE_CLAUDE_PATH }
    );
    const repair = findRepair(annotated, PLUGIN_CHECK_ID);

    assert.equal(repair?.repairable, true);
    assert.equal(repair?.blockedByCheckId, CLAUDE_CLI_CHECK_ID);
  });
});
