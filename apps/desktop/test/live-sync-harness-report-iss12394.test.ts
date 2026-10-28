/**
 * @file live-sync-harness-report-iss12394.test.ts
 * @description ISS-12394 — drives `collectLiveSyncViolations` through the real
 * `--verdict` CLI so the subprocess (c8) coverage lane sees the verdict's
 * branches. `live-sync-harness-report.test.ts` covers them in-process; this
 * pins the exact `::error::` lines the CI job prints for every violation kind.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(DESKTOP_DIR, "scripts", "live-sync-harness.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 90_000;
const ERROR_PREFIX = "::error::[live-sync-harness] ";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "live-sync-harness-report-iss12394-"));
});

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function runVerdict(report: unknown, cloud: unknown) {
  const reportFile = join(workDir, "report.json");
  const countsFile = join(workDir, "cloud-counts.json");
  writeFileSync(reportFile, JSON.stringify(report));
  writeFileSync(countsFile, JSON.stringify(cloud));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      SCRIPT_PATH,
      "--verdict",
      "--report",
      reportFile,
      "--cloud-counts",
      countsFile,
    ],
    {
      cwd: DESKTOP_DIR,
      encoding: "utf8",
      env: process.env,
      timeout: SPAWN_TIMEOUT_MS,
    }
  );
  if (result.error) {
    throw new Error(`the harness did not run: ${result.error.message}`);
  }
  const errorLines = result.stderr
    .split("\n")
    .filter((line) => line.startsWith(ERROR_PREFIX))
    .map((line) => line.slice(ERROR_PREFIX.length));
  return { status: result.status, stderr: result.stderr, errorLines };
}

function tally(lane: string, overrides: Record<string, unknown>) {
  return {
    lane,
    accepted: 0,
    rejected: 0,
    deferred: 0,
    deadLettered: 0,
    reasons: [],
    ...overrides,
  };
}

describe("live-sync-harness --verdict violation sentences", () => {
  it("names every violation kind, eliding long lists and carrying the deferred reason", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const report = {
      sessionLaneDrained: false,
      durationMs: 1200,
      budgetMs: 1000,
      sessionsDelivered: 3,
      lanes: [
        tally(SyncLane.SessionMetadata, {
          rejected: 2,
          reasons: [SyncReason.ValidationFailed, SyncReason.ValidationFailed],
        }),
        tally(SyncLane.InvocationParts, { deferred: 2 }),
      ],
      deadLetters: { sessions: 1, components: 2, invocationParts: 3 },
      syncFailures: [
        "sync failed: a",
        "sync failed: b",
        "sync failed: c",
        "sync failed: d",
      ],
      rejectedDetails: ["d1", "d2", "d3", "d4", "d5", "d6"],
      laneRemainders: [
        {
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.Drained,
          itemsRemaining: 0,
        },
        {
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 4,
        },
        {
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.RemainingUnknown,
          itemsRemaining: null,
        },
      ],
      corpus: { sessions: 2, events: 10 },
    };

    const run = runVerdict(report, { sessions: 1, events: 9 });

    expect(run.status).toBe(1);
    expect(run.errorLines).toEqual([
      "The session lane did not drain within the 1000ms budget (gave up after 1200ms, 3 session(s) delivered).",
      `2 batch(es) were rejected — reasons: ${SyncReason.ValidationFailed}; server detail: d1, d2, d3, d4, d5 (+1 more).`,
      "6 row(s) were dead-lettered (1 session(s), 2 component row(s), 3 invocation part(s)).",
      `Lane ${SyncLaneId.InvocationParts} did not finish: state ${SyncLaneDrainState.Draining}, 4 item(s) still owed; 2 send(s) deferred — reason: ${SyncReason.SessionMissing}.`,
      `Lane ${SyncLaneId.ComponentInventory} did not finish: state ${SyncLaneDrainState.RemainingUnknown}, an unmeasured number of item(s) still owed.`,
      "The lane reported 4 distinct sync failure(s): sync failed: a, sync failed: b, sync failed: c (+1 more).",
      "The cloud stored 1 session(s); the corpus holds 2.",
      "The cloud stored 9 session event(s); the corpus holds 10.",
    ]);
    expect(run.stderr).toContain("8 live-sync violation(s)");
  });

  it("says the server sent no reason, flags an absent burn-down sample, and reports only the event shortfall", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const report = {
      sessionLaneDrained: true,
      durationMs: 10,
      budgetMs: 1000,
      sessionsDelivered: 2,
      lanes: [tally(SyncLane.SessionMetadata, { rejected: 1 })],
      deadLetters: { sessions: 0, components: 0, invocationParts: 0 },
      syncFailures: [],
      rejectedDetails: [],
      laneRemainders: [],
      corpus: { sessions: 2, events: 10 },
    };

    const run = runVerdict(report, { sessions: 2, events: 7 });

    expect(run.status).toBe(1);
    expect(run.errorLines).toEqual([
      "1 batch(es) were rejected — the server sent no reason.",
      "No burn-down sample completed, so no lane's queue depth was measured — " +
        "this run cannot say whether any lane still owes the cloud work.",
      "The cloud stored 7 session event(s); the corpus holds 10.",
    ]);
  });
});
