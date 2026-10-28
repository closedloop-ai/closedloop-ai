/**
 * @file live-sync-harness-iss11285.test.ts
 * @description ISS-11285 — subprocess coverage for the argument and input
 * refusals of `scripts/live-sync-harness.ts` that
 * `live-sync-harness-verdict.test.ts` does not reach: the usage error, a drain
 * report the verdict cannot read, a missing or unreadable cloud-counts file,
 * and the drain phase's `--store`, `--budget-ms` and env checks. Every case in
 * the first describe stops before a store is opened or the API is dialled; the
 * drain-phase describe opens a temp SQLite store and stops at the owner check.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARNESS_DRIVES_LANE } from "../scripts/live-sync-harness-report.js";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
} from "../src/shared/sync-burndown-contract.js";

const RE_USAGE = /usage: tsx scripts\/live-sync-harness\.ts --store <dir>/;
const RE_NOT_A_REPORT =
  /is not a drain report this build can read \(.+\)\. The drain phase must run/;
const RE_UNMEASURED =
  /::error::\[live-sync-harness\] The cloud-side counts were not measured/;
const RE_STORE_REQUIRED = /--store <dir> is required for the drain phase\./;
const RE_API_ORIGIN_REQUIRED =
  /CL_AUTH_API_ORIGIN is required; see this script's header\./;
const RE_API_KEY_REQUIRED =
  /CLOSEDLOOP_API_KEY is required; see this script's header\./;
const RE_BAD_BUDGET = /ignoring unusable --budget-ms "soon"; using 900000ms\./;
const RE_ZERO_BUDGET = /ignoring unusable --budget-ms "0"; using 900000ms\./;
const RE_CLAMPED_START =
  /\[live-sync-harness\] api=http:\/\/127\.0\.0\.1:9 relay=ws:\/\/relay\.invalid budget=1000ms/;
const RE_UNSET_RELAY_START =
  /\[live-sync-harness\] api=http:\/\/127\.0\.0\.1:9 relay=\(unset\) budget=900000ms/;
const RE_NO_OWNER = /no session in the store carries an owner identity/;

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(DESKTOP_DIR, "scripts", "live-sync-harness.ts");

/** `spawnSync` blocks the worker, so the child carries its own deadline. */
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 90_000;

const CORPUS = { sessions: 2, events: 5 };
/** A prior measurement the verdict must overwrite, so a skipped rewrite shows. */
const STALE_CLOUD = { sessions: 7, events: 11 };

type HarnessRun = { status: number | null; stdout: string; stderr: string };

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "live-sync-harness-iss11285-"));
});

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true });
});

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
    cloud: STALE_CLOUD,
  };
}

function runHarness(
  args: string[],
  envOverrides: Record<string, string> = {}
): HarnessRun {
  const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
  for (const key of [
    "CL_AUTH_API_ORIGIN",
    "CLOSEDLOOP_API_KEY",
    "CL_RELAY_ORIGIN",
  ]) {
    if (!(key in envOverrides)) {
      Reflect.deleteProperty(env, key);
    }
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, ...args],
    { cwd: DESKTOP_DIR, encoding: "utf8", env, timeout: SPAWN_TIMEOUT_MS }
  );
  if (result.error) {
    throw new Error(`the harness did not run: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function writeReport(contents: unknown): string {
  const reportFile = join(workDir, "report.json");
  writeFileSync(reportFile, JSON.stringify(contents));
  return reportFile;
}

function readReport(reportFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(reportFile, "utf8"));
}

describe("live-sync-harness argument refusals", () => {
  it("exits 1 with the usage text when --report is absent", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runHarness(["--verdict"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_USAGE);
  });

  it("refuses a drain report missing required fields and leaves the file untouched", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const truncated = { sessionLaneDrained: true };
    const reportFile = writeReport(truncated);

    const run = runHarness(["--verdict", "--report", reportFile]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_NOT_A_REPORT);
    expect(readReport(reportFile)).toEqual(truncated);
  });

  it("records cloud as unmeasured and fails when --cloud-counts is not passed", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const reportFile = writeReport(drainReport());

    const run = runHarness(["--verdict", "--report", reportFile]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_UNMEASURED);
    expect(readReport(reportFile).cloud).toBeNull();
  });

  it("records cloud as unmeasured when the cloud-counts file is not valid JSON", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const reportFile = writeReport(drainReport());
    const countsFile = join(workDir, "cloud-counts.json");
    writeFileSync(countsFile, "{ sessions: 2");

    const run = runHarness([
      "--verdict",
      "--report",
      reportFile,
      "--cloud-counts",
      countsFile,
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_UNMEASURED);
    expect(readReport(reportFile).cloud).toBeNull();
  });

  it("requires --store for the drain phase and writes no report", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const reportFile = join(workDir, "report.json");

    const run = runHarness(["--report", reportFile]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_STORE_REQUIRED);
    expect(() => readFileSync(reportFile)).toThrow();
  });

  it("warns on an unusable --budget-ms, then refuses an unset CL_AUTH_API_ORIGIN", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runHarness([
      "--report",
      join(workDir, "report.json"),
      "--store",
      workDir,
      "--budget-ms",
      "soon",
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_BAD_BUDGET);
    expect(run.stderr).toMatch(RE_API_ORIGIN_REQUIRED);
  });

  it("treats a whitespace-only CLOSEDLOOP_API_KEY as unset", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runHarness(
      ["--report", join(workDir, "report.json"), "--store", workDir],
      { CL_AUTH_API_ORIGIN: "http://127.0.0.1:9", CLOSEDLOOP_API_KEY: "   " }
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_API_KEY_REQUIRED);
    expect(run.stderr).not.toMatch(RE_BAD_BUDGET);
  });
});

describe("live-sync-harness drain phase against a store with no owned session", () => {
  const credentials = {
    CL_AUTH_API_ORIGIN: "http://127.0.0.1:9",
    CLOSEDLOOP_API_KEY: "sk_live_iss11285",
  };

  it("clamps a small budget to the floor, trims the relay origin, and fails on the missing owner without writing a report", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const reportFile = join(workDir, "report.json");

    const run = runHarness(
      [
        "--report",
        reportFile,
        "--store",
        join(workDir, "store"),
        "--budget-ms",
        "100",
      ],
      { ...credentials, CL_RELAY_ORIGIN: "  ws://relay.invalid  " }
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(RE_CLAMPED_START);
    expect(run.stderr).toMatch(RE_NO_OWNER);
    expect(() => readFileSync(reportFile)).toThrow();
  });

  it("falls back to the default for a zero budget and logs an unset relay", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const run = runHarness(
      [
        "--report",
        join(workDir, "report.json"),
        "--store",
        join(workDir, "store"),
        "--budget-ms",
        "0",
      ],
      credentials
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_ZERO_BUDGET);
    expect(run.stdout).toMatch(RE_UNSET_RELAY_START);
    expect(run.stderr).toMatch(RE_NO_OWNER);
  });
});
