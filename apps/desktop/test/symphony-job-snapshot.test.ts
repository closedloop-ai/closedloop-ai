import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { LocalJob, LocalJobStatus } from "../src/main/job-store.js";
import {
  deriveHarnessJobStatus,
  enrichJobSnapshot,
  shouldApplyStateStatus,
} from "../src/server/operations/symphony-job-snapshot.js";
import {
  clearPendingLoopExit,
  registerPendingLoopExit,
} from "../src/server/operations/symphony-loop-lifecycle.js";

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-1",
    command: LoopCommand.Plan,
    status: "RUNNING" as LocalJobStatus,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// -- Ghost QUEUED/STARTING job expiry --

test("QUEUED job with no PID older than 60s becomes FAILED", async () => {
  const oldDate = new Date(Date.now() - 90_000).toISOString();
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "QUEUED", pid: undefined, startedAt: oldDate })
  );
  assert.equal(snapshot.status, "FAILED");
});

test("QUEUED job with no PID younger than 60s stays QUEUED", async () => {
  const recentDate = new Date(Date.now() - 10_000).toISOString();
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "QUEUED", pid: undefined, startedAt: recentDate })
  );
  assert.equal(snapshot.status, "QUEUED");
});

test("STARTING job with no PID older than 60s becomes FAILED", async () => {
  const oldDate = new Date(Date.now() - 90_000).toISOString();
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "STARTING", pid: undefined, startedAt: oldDate })
  );
  assert.equal(snapshot.status, "FAILED");
});

test("STARTING job with no PID younger than 60s stays STARTING", async () => {
  const recentDate = new Date(Date.now() - 5000).toISOString();
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "STARTING", pid: undefined, startedAt: recentDate })
  );
  assert.equal(snapshot.status, "STARTING");
});

// -- Process liveness finalization --

test("CANCEL_PENDING job with dead process becomes CANCELLED", async () => {
  // Use PID 999999999 which should not exist
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "CANCEL_PENDING", pid: 999_999_999 })
  );
  assert.equal(snapshot.status, "CANCELLED");
  assert.equal(snapshot.processRunning, false);
});

test("RUNNING job with dead process becomes STOPPED", async () => {
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "RUNNING", pid: 999_999_999 })
  );
  assert.equal(snapshot.status, "STOPPED");
  assert.equal(snapshot.processRunning, false);
});

test("RUNNING job with pending exit and dead process stays RUNNING", async () => {
  registerPendingLoopExit("loop-1");
  try {
    const snapshot = await enrichJobSnapshot(
      makeJob({ status: "RUNNING", pid: 999_999_999 })
    );
    assert.equal(snapshot.status, "RUNNING");
    assert.equal(snapshot.processRunning, false);
  } finally {
    clearPendingLoopExit("loop-1");
  }
});

test("CANCEL_PENDING job with pending exit and dead process becomes CANCELLED", async () => {
  registerPendingLoopExit("loop-1");
  try {
    const snapshot = await enrichJobSnapshot(
      makeJob({ status: "CANCEL_PENDING", pid: 999_999_999 })
    );
    assert.equal(snapshot.status, "CANCELLED");
    assert.equal(snapshot.processRunning, false);
  } finally {
    clearPendingLoopExit("loop-1");
  }
});

// -- Snapshot shape --

test("snapshot includes processRunning field", async () => {
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "QUEUED", pid: undefined })
  );
  assert.equal(snapshot.processRunning, false);
});

test("completed job status is not overridden", async () => {
  const snapshot = await enrichJobSnapshot(
    makeJob({ status: "COMPLETED", pid: undefined })
  );
  assert.equal(snapshot.status, "COMPLETED");
});

// -- Terminal status guard (shouldApplyStateStatus) --

test("shouldApplyStateStatus: COMPLETED + processRunning=true is suppressed", () => {
  assert.equal(shouldApplyStateStatus("COMPLETED", true), false);
});

test("shouldApplyStateStatus: COMPLETED + processRunning=false is applied", () => {
  assert.equal(shouldApplyStateStatus("COMPLETED", false), true);
});

test("shouldApplyStateStatus: AWAITING_USER + processRunning=true passes through", () => {
  assert.equal(shouldApplyStateStatus("AWAITING_USER", true), true);
});

test("shouldApplyStateStatus: FAILED + processRunning=true is suppressed", () => {
  assert.equal(shouldApplyStateStatus("FAILED", true), false);
});

test("shouldApplyStateStatus: RUNNING + processRunning=true passes through", () => {
  assert.equal(shouldApplyStateStatus("RUNNING", true), true);
});

// -- enrichJobSnapshot integration: state.json status/phase suppression --

test("enrichJobSnapshot: RUNNING job stays RUNNING when state.json says COMPLETED and process is alive", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    const statePath = path.join(tmpDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ status: "COMPLETED", phase: "Completed" })
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({ status: "RUNNING", pid: process.pid, statePath })
    );
    assert.equal(snapshot.status, "RUNNING");
    assert.notEqual(snapshot.phase, "Completed");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("enrichJobSnapshot: RUNNING job becomes COMPLETED when state.json says COMPLETED and process is dead", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    const statePath = path.join(tmpDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ status: "COMPLETED", phase: "Completed" })
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({ status: "RUNNING", pid: 999_999_999, statePath })
    );
    assert.equal(snapshot.status, "COMPLETED");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// S5 (compat): present, non-terminal state.json status is still honored, but
// `phase` is never surfaced anymore (phase-drop contract).
test("enrichJobSnapshot: RUNNING job gets AWAITING_USER from state.json when process is alive (phase dropped)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    const statePath = path.join(tmpDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ status: "AWAITING_USER", phase: "Waiting for input" })
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({ status: "RUNNING", pid: process.pid, statePath })
    );
    assert.equal(snapshot.status, "AWAITING_USER");
    assert.equal(snapshot.phase, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// S7: a legacy state.json carrying a phase (and a persisted job.phase) never
// reaches the snapshot — phase is always dropped, status stays RUNNING.
test("enrichJobSnapshot: phase is always dropped even when state.json and job carry one", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    const statePath = path.join(tmpDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ status: "FAILED", phase: "Failed" })
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({
        status: "RUNNING",
        pid: process.pid,
        statePath,
        phase: "Building",
      })
    );
    assert.equal(snapshot.status, "RUNNING");
    assert.equal(snapshot.phase, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("enrichJobSnapshot preserves execute finalization diagnostics", async () => {
  const snapshot = await enrichJobSnapshot(
    makeJob({
      command: LoopCommand.Execute,
      status: "COMPLETED",
      finalizationSource: "boot-recovery",
      executeFinalizationStatus: "success",
      executeFinalizationPath: "artifact-existing",
      executeFinalizationReason: "existing execution-result.json reused",
      executeFinalizationPreExecutionResultPresent: true,
      executeFinalizationPrePrBodyPresent: false,
      executeFinalizationPostExecutionResultPresent: true,
      executeFinalizationPostPrBodyPresent: false,
    })
  );
  assert.equal(snapshot.finalizationSource, "boot-recovery");
  assert.equal(snapshot.executeFinalizationStatus, "success");
  assert.equal(snapshot.executeFinalizationPath, "artifact-existing");
  assert.equal(
    snapshot.executeFinalizationReason,
    "existing execution-result.json reused"
  );
  assert.equal(snapshot.executeFinalizationPreExecutionResultPresent, true);
  assert.equal(snapshot.executeFinalizationPrePrBodyPresent, false);
  assert.equal(snapshot.executeFinalizationPostExecutionResultPresent, true);
  assert.equal(snapshot.executeFinalizationPostPrBodyPresent, false);
});

// -- deriveHarnessJobStatus: pure D-002 precedence (no fs) --

test("deriveHarnessJobStatus S1: clean exit + required present → COMPLETED", () => {
  assert.equal(
    deriveHarnessJobStatus({
      exitCode: 0,
      processRunning: false,
      requiredArtifactsPresent: true,
      awaitingSignalPresent: false,
    }),
    "COMPLETED"
  );
});

test("deriveHarnessJobStatus S2: clean exit + required absent → FAILED", () => {
  assert.equal(
    deriveHarnessJobStatus({
      exitCode: 0,
      processRunning: false,
      requiredArtifactsPresent: false,
      awaitingSignalPresent: false,
    }),
    "FAILED"
  );
});

test("deriveHarnessJobStatus S3: clean exit + awaiting signal → AWAITING_USER", () => {
  assert.equal(
    deriveHarnessJobStatus({
      exitCode: 0,
      processRunning: false,
      requiredArtifactsPresent: true,
      awaitingSignalPresent: true,
    }),
    "AWAITING_USER"
  );
});

test("deriveHarnessJobStatus S4: non-zero exit → FAILED regardless of artifacts", () => {
  assert.equal(
    deriveHarnessJobStatus({
      exitCode: 1,
      processRunning: false,
      requiredArtifactsPresent: true,
      awaitingSignalPresent: true,
    }),
    "FAILED"
  );
});

test("deriveHarnessJobStatus S6: clean exit + missing artifact + awaiting → AWAITING_USER (awaiting > completeness)", () => {
  assert.equal(
    deriveHarnessJobStatus({
      exitCode: 0,
      processRunning: false,
      requiredArtifactsPresent: false,
      awaitingSignalPresent: true,
    }),
    "AWAITING_USER"
  );
});

test("deriveHarnessJobStatus: live process → RUNNING regardless of signals", () => {
  assert.equal(
    deriveHarnessJobStatus({
      exitCode: null,
      processRunning: true,
      requiredArtifactsPresent: false,
      awaitingSignalPresent: true,
    }),
    "RUNNING"
  );
});

// -- enrichJobSnapshot integration: harness branch (no state.json) --

// S1: EXECUTE, exit 0, execution-result.json present, no state.json → COMPLETED.
test("enrichJobSnapshot harness branch: EXECUTE with execution-result.json and clean exit → COMPLETED", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    writeFileSync(
      path.join(tmpDir, "execution-result.json"),
      JSON.stringify({ has_changes: false })
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Execute,
        status: "RUNNING",
        pid: 999_999_999,
        exitCode: 0,
        claudeWorkDir: tmpDir,
      })
    );
    assert.equal(snapshot.status, "COMPLETED");
    assert.equal(snapshot.phase, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// S2: PLAN, exit 0, plan.json absent, no state.json → FAILED.
test("enrichJobSnapshot harness branch: PLAN with clean exit but no plan.json → FAILED", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Plan,
        status: "RUNNING",
        pid: 999_999_999,
        exitCode: 0,
        claudeWorkDir: tmpDir,
      })
    );
    assert.equal(snapshot.status, "FAILED");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// S3: PLAN, exit 0, open-questions.md present + plan not finalized → AWAITING_USER.
test("enrichJobSnapshot harness branch: PLAN with open-questions.md and unfinalized plan → AWAITING_USER", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    writeFileSync(
      path.join(tmpDir, "open-questions.md"),
      "# Open Questions\n- needs input\n"
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Plan,
        status: "RUNNING",
        pid: 999_999_999,
        exitCode: 0,
        claudeWorkDir: tmpDir,
      })
    );
    assert.equal(snapshot.status, "AWAITING_USER");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Harness branch defers to the live-exit handler when no exit code is recorded
// yet and that handler still owns the job (race guard).
test("enrichJobSnapshot harness branch: defers to live-exit handler when exit pending", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  registerPendingLoopExit("loop-1");
  try {
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Plan,
        status: "RUNNING",
        pid: 999_999_999,
        exitCode: null,
        claudeWorkDir: tmpDir,
      })
    );
    // Not derived to a terminal status; stays RUNNING for the exit path.
    assert.equal(snapshot.status, "RUNNING");
  } finally {
    clearPendingLoopExit("loop-1");
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Sentinel fallback: a clean-exit PLAN whose stream printed the reserved
// AWAITING_USER marker is awaiting even when artifacts look finalized.
test("enrichJobSnapshot harness branch: AWAITING_USER sentinel in stream → AWAITING_USER", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    writeFileSync(
      path.join(tmpDir, "plan.json"),
      JSON.stringify({ pendingTasks: [], completedTasks: [{ id: "t1" }] })
    );
    const jsonlPath = path.join(tmpDir, "claude-output.jsonl");
    writeFileSync(jsonlPath, '{"type":"text"}\n<<AWAITING_USER>>\n');
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Plan,
        status: "RUNNING",
        pid: 999_999_999,
        exitCode: 0,
        claudeWorkDir: tmpDir,
        jsonlPath,
      })
    );
    assert.equal(snapshot.status, "AWAITING_USER");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Re-entry: a job already resting in AWAITING_USER is re-polled with a dead
// process. The harness branch must re-derive AWAITING_USER and set
// harnessDerived so the dead-process STOPPED finalizer does NOT reap it.
test("enrichJobSnapshot harness branch: AWAITING_USER re-entry with dead process stays AWAITING_USER (not STOPPED)", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    writeFileSync(
      path.join(tmpDir, "open-questions.md"),
      "# Open Questions\n- still needs input\n"
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Plan,
        status: "AWAITING_USER",
        pid: 999_999_999,
        exitCode: 0,
        claudeWorkDir: tmpDir,
      })
    );
    assert.equal(snapshot.status, "AWAITING_USER");
    assert.equal(snapshot.processRunning, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Re-entry resolution: an AWAITING_USER job whose questions were answered
// (open-questions.md gone, plan finalized, clean exit) transitions to COMPLETED
// on the next poll rather than being stranded in AWAITING_USER.
test("enrichJobSnapshot harness branch: AWAITING_USER re-entry resolves to COMPLETED when artifacts finalized", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  try {
    writeFileSync(
      path.join(tmpDir, "plan.json"),
      JSON.stringify({ pendingTasks: [], completedTasks: [{ id: "t1" }] })
    );
    const snapshot = await enrichJobSnapshot(
      makeJob({
        command: LoopCommand.Plan,
        status: "AWAITING_USER",
        pid: 999_999_999,
        exitCode: 0,
        claudeWorkDir: tmpDir,
      })
    );
    assert.equal(snapshot.status, "COMPLETED");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
