import { readFileSync } from "node:fs";
import { seedRunningLoopsFromJobStore } from "./boot-loop-registry-seed.js";
import type { JobStore, LocalJob } from "./job-store.js";

/**
 * Boot-time job reconciliation: every persisted local job is re-checked against
 * the live process table so a job whose runner died while the app was closed is
 * finalized instead of being resurrected as RUNNING.
 *
 * Returns the reconciled jobs; the caller hands the dead ones to the boot
 * recovery service for background finalization.
 *
 * The survivors are the other half of the same step: a job whose runner is
 * still alive is re-adopted into the in-process running-loop registry here,
 * synchronously, before anything can accept a cloud command. That ordering is
 * the whole point (ISS-5811), so it lives inside this function rather than as a
 * second call a future caller could drop, reorder, or make async. See
 * `seedRunningLoopsFromJobStore` for why a per-process registry needs seeding
 * from persisted state at all.
 */
export function reconcileJobStoreOnBoot(jobStore: JobStore): LocalJob[] {
  const deadJobs = jobStore.reconcile((job) => reconcileJob(job));
  seedRunningLoopsFromJobStore(jobStore);
  return deadJobs;
}

function reconcileJob(job: LocalJob): LocalJob {
  const now = new Date().toISOString();

  // If no PID, we cannot verify liveness
  if (job.pid == null) {
    // Preserve CANCEL_PENDING -- we don't know if the process is gone
    if (job.status === "CANCEL_PENDING") {
      return job;
    }
    return { ...job, status: "UNKNOWN", updatedAt: now, completedAt: now };
  }

  if (!isProcessAlive(job.pid)) {
    return reconcileDeadJob(job, now);
  }

  // Process is still alive -- preserve existing status (RUNNING, CANCEL_PENDING, etc.)
  // Only upgrade to RUNNING if it was in a pre-running state
  if (job.status === "QUEUED" || job.status === "STARTING") {
    return { ...job, status: "RUNNING", updatedAt: now };
  }
  return { ...job, updatedAt: now };
}

/** Check whether the process is still alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The runner process is gone. Prefer the final status the runner wrote to its
 * `state.json`; fall back to CANCELLED for a confirmed cancel, else UNKNOWN.
 */
function reconcileDeadJob(job: LocalJob, now: string): LocalJob {
  // Try to determine final status from state.json
  const finalized = job.statePath
    ? finalizeFromStateFile(job, job.statePath, now)
    : null;
  if (finalized) {
    return finalized;
  }
  // CANCEL_PENDING + process dead = confirmed cancelled
  if (job.status === "CANCEL_PENDING") {
    return {
      ...job,
      status: "CANCELLED",
      updatedAt: now,
      completedAt: now,
    };
  }
  return { ...job, status: "UNKNOWN", updatedAt: now, completedAt: now };
}

/**
 * Read the runner's `state.json` for its terminal status. An unreadable or
 * unrecognized file yields null so the caller falls through to its own default.
 */
function finalizeFromStateFile(
  job: LocalJob,
  statePath: string,
  now: string
): LocalJob | null {
  let rawStatus: string | null = null;
  try {
    const stateRaw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(stateRaw) as Record<string, unknown>;
    rawStatus =
      typeof state.status === "string" ? state.status.toUpperCase() : null;
  } catch {
    // state.json unreadable -- fall through
    return null;
  }
  if (rawStatus === "COMPLETED") {
    return { ...job, status: "COMPLETED", updatedAt: now, completedAt: now };
  }
  if (rawStatus === "FAILED") {
    return { ...job, status: "FAILED", updatedAt: now, completedAt: now };
  }
  if (rawStatus === "CANCELLED") {
    return { ...job, status: "CANCELLED", updatedAt: now, completedAt: now };
  }
  if (rawStatus === "AWAITING_USER") {
    return { ...job, status: "AWAITING_USER", updatedAt: now };
  }
  if (rawStatus === "STOPPED") {
    return { ...job, status: "STOPPED", updatedAt: now, completedAt: now };
  }
  return null;
}
