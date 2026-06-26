/**
 * Tests for the race condition between desktop:list-running-jobs IPC
 * reconciliation and handleProcessCompletion's live-exit path.
 *
 * The bug: when the Electron renderer polls for running jobs right after a
 * process exits (but before handleProcessCompletion finishes), enrichJobSnapshot
 * sees a dead process with RUNNING status and returns STOPPED. The IPC handler
 * persists STOPPED to the JobStore, causing the live-exit finalizer to post a
 * PROCESS_STOPPED error instead of a COMPLETED event.
 *
 * The fix has three parts:
 *   1. onceComplete persists exitCode synchronously before the first await,
 *      "claiming" the job for the live-exit handler.
 *   2. The IPC handler skips PID-only STOPPED reconciliation for jobs with
 *      exitCode already set, while still accepting artifact-backed completion.
 *   3. A pending-exit marker suppresses STOPPED before the detached child's
 *      Node exit event has been delivered.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  isTerminalJobStatus,
  JobStore,
  type LocalJob,
} from "../src/main/job-store.js";
import { enrichJobSnapshot } from "../src/server/operations/symphony-job-snapshot.js";
import {
  clearPendingLoopExit,
  registerPendingLoopExit,
} from "../src/server/operations/symphony-loop-lifecycle.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPendingLoopExit("loop-race-1");
  clearPendingLoopExit("loop-short-lived-detached");
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempJobStore(name: string): { store: JobStore; tmpDir: string } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ipc-race-test-"));
  tempDirs.push(tmpDir);
  return { store: new JobStore({ cwd: tmpDir, name }), tmpDir };
}

function makeRunningJob(overrides: Partial<LocalJob> = {}): LocalJob {
  const now = new Date().toISOString();
  return {
    id: "loop-race-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-race-1",
    command: LoopCommand.Plan,
    status: "RUNNING",
    pid: 999_999_999,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Simulate the IPC reconciliation logic from app.ts desktop:list-running-jobs.
 * This is extracted here to test the exact same algorithm.
 */
function simulateIpcReconciliation(
  jobStore: JobStore,
  snapshots: (LocalJob & { processRunning: boolean })[]
): (LocalJob & { processRunning: boolean })[] {
  const stillRunning = [];
  for (const snapshot of snapshots) {
    const rawJob = jobStore.getById(snapshot.id);
    if (
      isTerminalJobStatus(snapshot.status) &&
      !isTerminalJobStatus(rawJob?.status ?? "UNKNOWN")
    ) {
      if (shouldDeferClaimedJobSnapshot(rawJob, snapshot)) {
        stillRunning.push({ ...snapshot, status: rawJob.status });
        continue;
      }
      jobStore.upsert({
        ...rawJob!,
        status: snapshot.status,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    } else if (!isTerminalJobStatus(snapshot.status)) {
      stillRunning.push(snapshot);
    }
  }
  return stillRunning;
}

function shouldDeferClaimedJobSnapshot(
  rawJob: LocalJob | undefined,
  snapshot: LocalJob
): rawJob is LocalJob {
  if (!rawJob || rawJob.exitCode == null) {
    return false;
  }
  return !(snapshot.status === "COMPLETED" && rawJob.exitCode === 0);
}

// ---------------------------------------------------------------------------
// Race condition prevention: exitCode claim prevents STOPPED override
// ---------------------------------------------------------------------------

test("IPC reconciliation skips STOPPED override when exitCode is already set (race prevention)", async () => {
  const { store } = makeTempJobStore("race-exitcode-set");
  const job = makeRunningJob({ exitCode: 0 });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(
    snapshot.status,
    "STOPPED",
    "enrichment should detect dead process as STOPPED"
  );
  assert.equal(snapshot.processRunning, false);

  simulateIpcReconciliation(store, [snapshot]);

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(
    afterReconcile?.status,
    "RUNNING",
    "job should remain RUNNING — exit handler has claimed it via exitCode"
  );
});

test("IPC reconciliation skips STOPPED override for non-zero exitCode too", async () => {
  const { store } = makeTempJobStore("race-exitcode-nonzero");
  const job = makeRunningJob({ exitCode: 1 });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "STOPPED");

  simulateIpcReconciliation(store, [snapshot]);

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(
    afterReconcile?.status,
    "RUNNING",
    "non-zero exitCode also means exit handler is processing"
  );
});

test("IPC reconciliation persists clean harness completion when required artifact is present", async () => {
  const { store, tmpDir } = makeTempJobStore("race-harness-completed");
  writeFileSync(
    path.join(tmpDir, "plan.json"),
    JSON.stringify({ pendingTasks: [], completedTasks: [{ id: "t1" }] })
  );
  const job = makeRunningJob({
    claudeWorkDir: tmpDir,
    exitCode: 0,
  });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(
    snapshot.status,
    "COMPLETED",
    "harness branch should derive completion from clean exit and plan.json"
  );

  const result = simulateIpcReconciliation(store, [snapshot]);
  assert.equal(
    result.length,
    0,
    "completed harness job should leave the running-jobs response"
  );

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(
    afterReconcile?.status,
    "COMPLETED",
    "artifact-backed completion should be persisted despite exitCode claim"
  );
});

// ---------------------------------------------------------------------------
// Normal case: orphaned processes still get reconciled to STOPPED
// ---------------------------------------------------------------------------

test("IPC reconciliation sets STOPPED for dead process with no exitCode (orphaned job)", async () => {
  const { store } = makeTempJobStore("race-no-exitcode");
  const job = makeRunningJob();
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "STOPPED");

  simulateIpcReconciliation(store, [snapshot]);

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(
    afterReconcile?.status,
    "STOPPED",
    "without exitCode, reconciliation should proceed normally"
  );
});

test("IPC reconciliation keeps pending-exit dead process running until exit handler claims it", async () => {
  const { store } = makeTempJobStore("race-pending-exit");
  const job = makeRunningJob();
  store.upsert(job);
  registerPendingLoopExit(job.loopId);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "RUNNING");
  assert.equal(snapshot.processRunning, false);

  const result = simulateIpcReconciliation(store, [snapshot]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "RUNNING");

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(afterReconcile?.status, "RUNNING");
});

test("IPC reconciliation sets CANCELLED for dead CANCEL_PENDING job with no exitCode", async () => {
  const { store } = makeTempJobStore("race-cancel-pending");
  const job = makeRunningJob({ status: "CANCEL_PENDING" });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "CANCELLED");

  simulateIpcReconciliation(store, [snapshot]);

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(
    afterReconcile?.status,
    "CANCELLED",
    "CANCEL_PENDING → CANCELLED reconciliation should work normally"
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("IPC reconciliation skips already-terminal jobs", async () => {
  const { store } = makeTempJobStore("race-already-terminal");
  const job = makeRunningJob({ status: "COMPLETED" });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "COMPLETED");

  const result = simulateIpcReconciliation(store, [snapshot]);
  assert.equal(
    result.length,
    0,
    "completed job should not appear in stillRunning"
  );

  const afterReconcile = store.getByLoopId("loop-race-1");
  assert.equal(afterReconcile?.status, "COMPLETED");
});

test("IPC reconciliation returns raw RUNNING status for claimed jobs (no UI flicker)", async () => {
  const { store } = makeTempJobStore("race-no-flicker");
  const job = makeRunningJob({ exitCode: 0 });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "STOPPED", "enrichment returns STOPPED");

  const result = simulateIpcReconciliation(store, [snapshot]);
  assert.equal(result.length, 1);
  assert.equal(
    result[0]?.status,
    "RUNNING",
    "claimed job should appear as RUNNING in IPC result, not STOPPED"
  );
});

test("IPC reconciliation passes through non-terminal snapshots", async () => {
  const { store } = makeTempJobStore("race-still-running");
  const job = makeRunningJob({ pid: process.pid });
  store.upsert(job);

  const snapshot = await enrichJobSnapshot(job);
  assert.equal(snapshot.status, "RUNNING");
  assert.equal(snapshot.processRunning, true);

  const result = simulateIpcReconciliation(store, [snapshot]);
  assert.equal(result.length, 1, "still-running job should be in the result");
  assert.equal(result[0]?.status, "RUNNING");
});

test("short-lived detached child never snapshots as STOPPED before exitCode claim", async () => {
  const { store } = makeTempJobStore("race-short-lived-detached");
  const loopId = "loop-short-lived-detached";
  const child = spawn(process.execPath, ["-e", ""], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.equal(typeof pid, "number");

  const now = new Date().toISOString();
  const job: LocalJob = {
    id: loopId,
    kind: "SYMPHONY_LOOP",
    loopId,
    command: LoopCommand.Plan,
    status: "RUNNING",
    pid,
    startedAt: now,
    updatedAt: now,
  };
  store.upsert(job);
  registerPendingLoopExit(loopId);

  let exitDelivered = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    exitDelivered = true;
    exitCode = code;
  });

  const statuses: LocalJob["status"][] = [];
  try {
    for (let i = 0; i < 500 && !exitDelivered; i += 1) {
      const snapshot = await enrichJobSnapshot(job);
      statuses.push(snapshot.status);
      assert.notEqual(snapshot.status, "STOPPED");
      await new Promise((resolve) => setImmediate(resolve));
    }

    await new Promise<void>((resolve, reject) => {
      if (exitDelivered) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for detached child exit"));
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const claimed = store.getByLoopId(loopId);
    assert.ok(claimed);
    store.upsert({
      ...claimed,
      exitCode: exitCode ?? 0,
      updatedAt: new Date().toISOString(),
    });
    clearPendingLoopExit(loopId);

    const afterClaim = await enrichJobSnapshot(store.getByLoopId(loopId)!);
    assert.equal(afterClaim.status, "STOPPED");
    simulateIpcReconciliation(store, [afterClaim]);
    assert.equal(store.getByLoopId(loopId)?.status, "RUNNING");
    assert.ok(
      statuses.length > 0,
      "test must poll at least once before exit claim"
    );
  } finally {
    clearPendingLoopExit(loopId);
  }
});
