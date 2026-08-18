/**
 * Terminal-state persistence and finalization telemetry.
 *
 * Split out of `loop-finalizer.test.ts` (ISS-5872): that file had grown to
 * cover the whole finalization sequence — artifact upload, support bundles,
 * completed/error event posting, worktree cleanup — and these cases are a
 * different responsibility. `persistFinalJobStatus`, `parseJobWarnings` and
 * `emitFinalizationTelemetry` decide what the LOCAL record and the telemetry
 * stream say a finished job did, with no cloud call involved, so they need
 * none of that file's fetch, PATH or shell-cache scaffolding.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { JobStore, type LocalJob } from "../src/main/jobs/job-store.js";
import {
  emitFinalizationTelemetry,
  parseJobWarnings,
  persistFinalJobStatus,
} from "../src/main/loop/loop-finalizer.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";

let tempRoot = "";
let telemetryEvents: TelemetryEventPayload[] = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "loop-finalization-persistence-test-")
  );
  telemetryEvents = [];
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/** A URL whose embedded credentials were replaced by the warning sanitizer. */
const REDACTED_CREDENTIAL_URL = /^\S*:\/\/\*\*\*@/;

function createStore(name: string): JobStore {
  return new JobStore({ cwd: tempRoot, name });
}

function createBaseJob(overrides?: Partial<LocalJob>): LocalJob {
  return {
    id: "loop-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-1",
    command: LoopCommand.Plan,
    localRepoPath: path.join(tempRoot, "repo"),
    claudeWorkDir: path.join(tempRoot, "repo", "workdir"),
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("parseJobWarnings returns empty array when missing or blank", () => {
  assert.deepEqual(parseJobWarnings({}), []);
  assert.deepEqual(parseJobWarnings({ warning: "" }), []);
});

test("parseJobWarnings splits on semicolon, trims, and drops empty segments", () => {
  assert.deepEqual(parseJobWarnings({ warning: "a; b;  ;c" }), ["a", "b", "c"]);
});

test("persistFinalJobStatus sets COMPLETED when isSuccessStatus", () => {
  const jobStore = createStore("step-persist-success");
  const job = createBaseJob({ status: "RUNNING" });
  jobStore.upsert(job);

  persistFinalJobStatus(job, true, [], jobStore);

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.status, "COMPLETED");
  assert.ok(persisted?.finalStatusPersistedAt);
});

test("persistFinalJobStatus preserves FAILED when not success", () => {
  const jobStore = createStore("step-persist-failed");
  const job = createBaseJob({ status: "FAILED", exitCode: 2 });
  jobStore.upsert(job);

  persistFinalJobStatus(job, false, [], jobStore);

  assert.equal(jobStore.getByLoopId("loop-1")?.status, "FAILED");
});

test("persistFinalJobStatus maps CANCEL_PENDING to CANCELLED when not success", () => {
  const jobStore = createStore("step-persist-cancel-pending");
  const job = createBaseJob({ status: "CANCEL_PENDING", exitCode: 130 });
  jobStore.upsert(job);

  persistFinalJobStatus(job, false, [], jobStore);

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.status, "CANCELLED");
  assert.ok(persisted?.finalStatusPersistedAt);
});

test("persistFinalJobStatus is a no-op when finalStatusPersistedAt already set", () => {
  const jobStore = createStore("step-persist-idem");
  const firstFinalized = new Date().toISOString();
  const job = createBaseJob({
    status: "RUNNING",
    finalStatusPersistedAt: firstFinalized,
  });
  jobStore.upsert(job);

  persistFinalJobStatus(job, true, ["X"], jobStore);

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.finalStatusPersistedAt, firstFinalized);
  assert.notEqual(persisted?.status, "COMPLETED");
});

test("persistFinalJobStatus serializes warnings with sanitization", () => {
  const jobStore = createStore("step-persist-warn");
  const job = createBaseJob({ status: "RUNNING" });
  jobStore.upsert(job);

  const longToken = "a".repeat(50);
  persistFinalJobStatus(
    job,
    true,
    [`https://user:${longToken}@host`],
    jobStore
  );

  const w = jobStore.getByLoopId("loop-1")?.warning ?? "";
  assert.match(w, REDACTED_CREDENTIAL_URL);
  assert.ok(w.length <= 600);
});

test("emitFinalizationTelemetry uses job.completed on live-exit", () => {
  const jobStore = createStore("step-tel-live");
  const job = createBaseJob();
  jobStore.upsert(job);

  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  emitFinalizationTelemetry(
    job,
    "live-exit",
    claudeWorkDir,
    true,
    {
      emit: (e) => telemetryEvents.push(e),
    },
    jobStore
  );

  assert.equal(telemetryEvents[0]?.category, "job.completed");
  assert.equal(telemetryEvents[0]?.severity, "info");
  assert.equal(telemetryEvents[0]?.message, "Job completed successfully");
});

test("emitFinalizationTelemetry uses recovery category on boot-recovery", () => {
  const jobStore = createStore("step-tel-recovery");
  const job = createBaseJob({ status: "RUNNING" });
  jobStore.upsert(job);

  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  emitFinalizationTelemetry(
    job,
    "boot-recovery",
    claudeWorkDir,
    true,
    { emit: (e) => telemetryEvents.push(e) },
    jobStore
  );

  assert.equal(telemetryEvents[0]?.category, "job.recovery.finalize_replayed");
  assert.equal(telemetryEvents[0]?.severity, "info");
});

test("emitFinalizationTelemetry emits error severity for failed recovery finalization", () => {
  const jobStore = createStore("step-tel-err");
  const job = createBaseJob({ status: "FAILED" });
  jobStore.upsert(job);

  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  emitFinalizationTelemetry(
    job,
    "manual-repair",
    claudeWorkDir,
    false,
    { emit: (e) => telemetryEvents.push(e) },
    jobStore
  );

  assert.equal(telemetryEvents[0]?.category, "job.recovery.finalize_replayed");
  assert.equal(telemetryEvents[0]?.severity, "error");
});

test("emitFinalizationTelemetry reports a live-exit downgrade as an error, not a completion", () => {
  // ISS-5872: `reason === "live-exit"` used to short-circuit severity and
  // message, which was safe only while the live path could not reach here with
  // a failure. A run downgraded for a missing deliverable is FAILED on
  // live-exit, and calling that "Job completed successfully" tells telemetry
  // the opposite of what the cloud was told.
  const jobStore = createStore("step-tel-live-downgrade");
  const job = createBaseJob({
    status: "FAILED",
    missingRequiredArtifacts: ["plan.json"],
  });
  jobStore.upsert(job);

  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  emitFinalizationTelemetry(
    job,
    "live-exit",
    claudeWorkDir,
    false,
    { emit: (e) => telemetryEvents.push(e) },
    jobStore
  );

  assert.equal(telemetryEvents[0]?.severity, "error");
  assert.equal(
    telemetryEvents[0]?.message,
    "Job finalized with status FAILED via live-exit"
  );
  // The category still records WHICH path finalized the job, not whether it
  // succeeded, so it stays live-exit's.
  assert.equal(telemetryEvents[0]?.category, "job.completed");
});

test("emitFinalizationTelemetry keeps a live-exit cancellation at info severity", () => {
  const jobStore = createStore("step-tel-live-cancelled");
  const job = createBaseJob({ status: "CANCELLED" });
  jobStore.upsert(job);

  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  emitFinalizationTelemetry(
    job,
    "live-exit",
    claudeWorkDir,
    false,
    { emit: (e) => telemetryEvents.push(e) },
    jobStore
  );

  assert.equal(telemetryEvents[0]?.severity, "info");
  assert.equal(
    telemetryEvents[0]?.message,
    "Job cancellation finalized via live-exit"
  );
});
