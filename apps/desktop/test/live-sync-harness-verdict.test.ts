/**
 * @file live-sync-harness-verdict.test.ts
 * @description ISS-10512 — subprocess coverage for the verdict phase of
 * `scripts/live-sync-harness.ts`.
 *
 * The script calls `main()` at module scope, so it cannot be imported. Its
 * `--verdict` branch runs before any env read or store open, so it can be
 * spawned offline: write a drain report and a cloud-counts file, run the
 * verdict, and read the exit code and the report it rewrote. The child inherits
 * this process's env minus the API credentials, so the c8 node lane records it
 * and a verdict that reached for the API would fail here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { HARNESS_DRIVES_LANE } from "../scripts/live-sync-harness-report.js";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
} from "../src/shared/sync-burndown-contract.js";

// Hoisted per ultracite's useTopLevelRegex.
const RE_CLEAN = /drained 2 session\(s\) in 10ms with no rejected batch/;
const RE_SESSION_SHORTFALL =
  /::error::\[live-sync-harness\] The cloud stored 1 session\(s\); the corpus holds 2\./;
const RE_UNMEASURED =
  /::error::\[live-sync-harness\] The cloud-side counts were not measured/;

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(DESKTOP_DIR, "scripts", "live-sync-harness.ts");

/**
 * `spawnSync` blocks the worker's event loop, so the test runner's timeout
 * cannot interrupt a hung child; the child carries its own deadline.
 */
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 90_000;

const CORPUS = { sessions: 2, events: 5 };

function drainReport(): Record<string, unknown> {
  return {
    sessionLaneDrained: true,
    durationMs: 10,
    budgetMs: 900_000,
    sessionsDelivered: 2,
    lanes: [],
    deadLetters: { sessions: 0, components: 0, invocationParts: 0 },
    syncFailures: [],
    rejectedDetails: [],
    laneRemainders: SYNC_LANE_IDS.filter(
      (lane) => HARNESS_DRIVES_LANE[lane]
    ).map((lane) => ({
      lane,
      state: SyncLaneDrainState.Drained,
      itemsRemaining: 0,
    })),
    corpus: CORPUS,
    cloud: null,
    // A field a newer drain wrote; the verdict's schema passes it through.
    newerDrainField: "kept",
  };
}

type VerdictRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  report: Record<string, unknown>;
};

function runVerdict(cloudCountsText: string): VerdictRun {
  const dir = mkdtempSync(join(tmpdir(), "live-sync-harness-verdict-"));
  try {
    const reportFile = join(dir, "report.json");
    const cloudCountsFile = join(dir, "cloud-counts.json");
    writeFileSync(reportFile, JSON.stringify(drainReport()));
    writeFileSync(cloudCountsFile, cloudCountsText);

    const env = { ...process.env };
    Reflect.deleteProperty(env, "CL_AUTH_API_ORIGIN");
    Reflect.deleteProperty(env, "CLOSEDLOOP_API_KEY");
    Reflect.deleteProperty(env, "CL_RELAY_ORIGIN");

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
        cloudCountsFile,
      ],
      { cwd: DESKTOP_DIR, encoding: "utf8", env, timeout: SPAWN_TIMEOUT_MS }
    );
    if (result.error) {
      throw new Error(`the harness did not run: ${result.error.message}`);
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      report: JSON.parse(readFileSync(reportFile, "utf8")),
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("live-sync-harness --verdict, run as a subprocess", () => {
  test("a clean report exits 0 and gains the cloud counts", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runVerdict(JSON.stringify({ sessions: 2, events: 5 }));

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, RE_CLEAN);
    assert.deepEqual(run.report.cloud, { sessions: 2, events: 5 });
    assert.deepEqual(run.report.corpus, CORPUS);
    assert.equal(run.report.newerDrainField, "kept");
  });

  test("one count violation exits non-zero and names it", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runVerdict(JSON.stringify({ sessions: 1, events: 5 }));

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, RE_SESSION_SHORTFALL);
    assert.deepEqual(run.report.cloud, { sessions: 1, events: 5 });
  });

  test("a cloud-counts file the Zod boundary refuses is recorded as unmeasured and fails", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runVerdict(JSON.stringify({ sessions: 1.5, events: 5 }));

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, RE_UNMEASURED);
    assert.equal(run.report.cloud, null);
  });
});
