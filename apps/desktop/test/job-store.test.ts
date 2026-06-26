import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { LocalJob, LocalJobStatus } from "../src/main/job-store.js";
import { isTerminalJobStatus, JobStore } from "../src/main/job-store.js";

let tmpDir: string;
let store: JobStore;

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "job-1",
    kind: "SYMPHONY_LOOP",
    loopId: overrides.loopId ?? "loop-1",
    command: LoopCommand.Plan,
    status: "RUNNING" as LocalJobStatus,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-store-test-"));
  store = new JobStore({ cwd: tmpDir, name: "test-jobs" });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("upsert QUEUED keeps job in active list", () => {
  store.upsert(makeJob({ id: "j1", status: "QUEUED" }));
  assert.equal(store.listRunning().length, 1);
  assert.equal(store.listCompleted().length, 0);
});

test("upsert STOPPED moves job from active to terminal", () => {
  store.upsert(makeJob({ id: "j1", status: "RUNNING" }));
  assert.equal(store.listRunning().length, 1);

  store.upsert(makeJob({ id: "j1", status: "STOPPED" }));
  assert.equal(store.listRunning().length, 0);
  assert.equal(store.listCompleted().length, 1);
  assert.equal(store.listCompleted()[0].status, "STOPPED");
});

test("upsert COMPLETED moves job to terminal", () => {
  store.upsert(makeJob({ id: "j1", status: "RUNNING" }));
  store.upsert(makeJob({ id: "j1", status: "COMPLETED" }));
  assert.equal(store.listRunning().length, 0);
  assert.equal(store.listCompleted().length, 1);
});

test("getByLoopId finds jobs in both active and terminal lists", () => {
  store.upsert(
    makeJob({ id: "active", loopId: "loop-active", status: "RUNNING" })
  );
  store.upsert(
    makeJob({ id: "done", loopId: "loop-done", status: "COMPLETED" })
  );

  assert.equal(store.getByLoopId("loop-active")?.id, "active");
  assert.equal(store.getByLoopId("loop-done")?.id, "done");
  assert.equal(store.getByLoopId("nonexistent"), undefined);
});

test("listRunning returns only active jobs", () => {
  store.upsert(makeJob({ id: "a", status: "RUNNING" }));
  store.upsert(makeJob({ id: "b", status: "QUEUED" }));
  store.upsert(makeJob({ id: "c", status: "COMPLETED" }));

  const running = store.listRunning();
  assert.equal(running.length, 2);
  assert.ok(running.some((j) => j.id === "a"));
  assert.ok(running.some((j) => j.id === "b"));
});

test("listCompleted returns only terminal jobs", () => {
  store.upsert(makeJob({ id: "a", status: "RUNNING" }));
  store.upsert(makeJob({ id: "b", status: "FAILED" }));
  store.upsert(makeJob({ id: "c", status: "CANCELLED" }));

  const completed = store.listCompleted();
  assert.equal(completed.length, 2);
  assert.ok(completed.some((j) => j.id === "b"));
  assert.ok(completed.some((j) => j.id === "c"));
});

test("terminal list is capped at 100 entries", () => {
  for (let i = 0; i < 110; i++) {
    store.upsert(
      makeJob({ id: `j-${i}`, loopId: `loop-${i}`, status: "COMPLETED" })
    );
  }
  assert.equal(store.listCompleted().length, 100);
});

test("isTerminalJobStatus returns correct values", () => {
  assert.ok(isTerminalJobStatus("COMPLETED"));
  assert.ok(isTerminalJobStatus("FAILED"));
  assert.ok(isTerminalJobStatus("CANCELLED"));
  assert.ok(isTerminalJobStatus("STOPPED"));
  assert.ok(isTerminalJobStatus("UNKNOWN"));
  assert.ok(isTerminalJobStatus("TIMED_OUT"));
  assert.ok(!isTerminalJobStatus("QUEUED"));
  assert.ok(!isTerminalJobStatus("STARTING"));
  assert.ok(!isTerminalJobStatus("RUNNING"));
  assert.ok(!isTerminalJobStatus("CANCEL_PENDING"));
});

test("upsert TIMED_OUT moves job to terminal", () => {
  store.upsert(makeJob({ id: "j1", status: "RUNNING" }));
  assert.equal(store.listRunning().length, 1);

  store.upsert(
    makeJob({
      id: "j1",
      status: "TIMED_OUT",
      liveActivity: "Loop timed out — restart from the loop list.",
    })
  );
  assert.equal(store.listRunning().length, 0);
  assert.equal(store.listCompleted().length, 1);
  assert.equal(store.listCompleted()[0].status, "TIMED_OUT");
  assert.equal(
    store.listCompleted()[0].liveActivity,
    "Loop timed out — restart from the loop list."
  );
});

test("TIMED_OUT job persists across JobStore instantiation", () => {
  store.upsert(
    makeJob({
      id: "j1",
      loopId: "loop-1",
      status: "TIMED_OUT",
      liveActivity: "Loop timed out — restart from the loop list.",
    })
  );

  const store2 = new JobStore({ cwd: tmpDir, name: "test-jobs" });
  assert.equal(store2.getByLoopId("loop-1")?.status, "TIMED_OUT");
  assert.equal(
    store2.getByLoopId("loop-1")?.liveActivity,
    "Loop timed out — restart from the loop list."
  );
});

test("persists and restores across instances", () => {
  store.upsert(makeJob({ id: "a", loopId: "la", status: "RUNNING" }));
  store.upsert(makeJob({ id: "b", loopId: "lb", status: "COMPLETED" }));

  const store2 = new JobStore({ cwd: tmpDir, name: "test-jobs" });
  assert.equal(store2.listRunning().length, 1);
  assert.equal(store2.listCompleted().length, 1);
  assert.equal(store2.getByLoopId("la")?.id, "a");
  assert.equal(store2.getByLoopId("lb")?.id, "b");
});

test("persists execute finalization diagnostics and recovery inputs across instances", () => {
  const finalizedAt = new Date().toISOString();
  store.upsert(
    makeJob({
      id: "exec-1",
      loopId: "loop-exec-1",
      command: LoopCommand.Execute,
      status: "COMPLETED",
      artifactSlug: "artifact-slug",
      baseBranch: "release/test",
      webAppOrigin: "https://app.closedloop.ai",
      expectedMcpUrl: "http://127.0.0.1:8787/mcp",
      committer: {
        name: "Test Committer",
        email: "test@example.com",
      },
      finalizationSource: "boot-recovery",
      executeFinalizationStatus: "success",
      executeFinalizationPath: "artifact-existing",
      executeFinalizationStartedAt: finalizedAt,
      executeFinalizationCompletedAt: finalizedAt,
      executeFinalizationReason: "existing execution-result.json reused",
      executeFinalizationPreExecutionResultPresent: true,
      executeFinalizationPrePrBodyPresent: false,
      executeFinalizationPostExecutionResultPresent: true,
      executeFinalizationPostPrBodyPresent: false,
    })
  );

  const store2 = new JobStore({ cwd: tmpDir, name: "test-jobs" });
  const restored = store2.getByLoopId("loop-exec-1");
  assert.ok(restored);
  assert.equal(restored.command, LoopCommand.Execute);
  assert.equal(restored.artifactSlug, "artifact-slug");
  assert.equal(restored.baseBranch, "release/test");
  assert.equal(restored.webAppOrigin, "https://app.closedloop.ai");
  assert.equal(restored.expectedMcpUrl, "http://127.0.0.1:8787/mcp");
  assert.deepEqual(restored.committer, {
    name: "Test Committer",
    email: "test@example.com",
  });
  assert.equal(restored.finalizationSource, "boot-recovery");
  assert.equal(restored.executeFinalizationStatus, "success");
  assert.equal(restored.executeFinalizationPath, "artifact-existing");
  assert.equal(
    restored.executeFinalizationReason,
    "existing execution-result.json reused"
  );
  assert.equal(restored.executeFinalizationPreExecutionResultPresent, true);
  assert.equal(restored.executeFinalizationPrePrBodyPresent, false);
  assert.equal(restored.executeFinalizationPostExecutionResultPresent, true);
  assert.equal(restored.executeFinalizationPostPrBodyPresent, false);
});
