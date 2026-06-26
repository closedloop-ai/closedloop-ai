import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LoopArtifactFile } from "@closedloop-ai/loops-api/artifacts";
import { ResultBundle } from "@closedloop-ai/loops-api/bundles";
import type { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  isTerminalJobStatus,
  type LocalJob,
  type LocalJobCommand,
  type LocalJobStatus,
  type TaskProgress,
} from "../../main/job-store.js";
import { readPlanProgress } from "./agent-utils.js";
import { hasPendingLoopExit } from "./symphony-loop-lifecycle.js";
import { isProcessRunning } from "./symphony-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobSnapshot = LocalJob & {
  processRunning: boolean;
  taskProgress?: TaskProgress;
  currentTaskId?: string;
};

// ---------------------------------------------------------------------------
// Effective status / phase from state.json
// ---------------------------------------------------------------------------

export async function readEffectiveStatusFromState(statePath: string): Promise<{
  status: LocalJobStatus | null;
  phase: string | null;
}> {
  if (!existsSync(statePath)) {
    return { status: null, phase: null };
  }

  try {
    const raw = await readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    const rawStatus =
      typeof state.status === "string" ? state.status.toUpperCase() : null;
    const phase = typeof state.phase === "string" ? state.phase : null;

    let status: LocalJobStatus | null = null;
    if (rawStatus === "IN_PROGRESS") {
      status = "RUNNING";
    } else if (rawStatus === "AWAITING_USER") {
      status = "AWAITING_USER";
    } else if (rawStatus === "COMPLETED") {
      status = "COMPLETED";
    } else if (rawStatus === "FAILED") {
      status = "FAILED";
    } else if (rawStatus === "CANCELLED") {
      status = "CANCELLED";
    } else if (rawStatus === "STOPPED") {
      status = "STOPPED";
    }

    return { status, phase };
  } catch {
    return { status: null, phase: null };
  }
}

// ---------------------------------------------------------------------------
// Guard terminal status from state.json when process is alive
// ---------------------------------------------------------------------------

/**
 * Suppress terminal status from state.json when the process is still alive.
 */
export function shouldApplyStateStatus(
  stateStatus: string,
  processRunning: boolean
): boolean {
  if (!processRunning) {
    return true;
  }
  return !isTerminalJobStatus(stateStatus as LocalJobStatus);
}

// ---------------------------------------------------------------------------
// Log tail reading
// ---------------------------------------------------------------------------

export async function readLogTail(
  logPath: string,
  maxLines = 200
): Promise<string | null> {
  if (!existsSync(logPath)) {
    return null;
  }

  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enrich a LocalJob with live snapshot data
// ---------------------------------------------------------------------------

export async function enrichJobSnapshot(job: LocalJob): Promise<JobSnapshot> {
  const processRunning = job.pid == null ? false : isProcessRunning(job.pid);

  let taskProgress = job.taskProgress;
  let currentTaskId = job.currentTaskId;
  let status = job.status;

  if (job.claudeWorkDir) {
    const planPath = path.join(job.claudeWorkDir, "plan.json");
    const planData = await readPlanProgress(planPath);
    if (planData.taskProgress) {
      taskProgress = planData.taskProgress;
    }
    if (planData.currentTaskId) {
      currentTaskId = planData.currentTaskId;
    }
  }

  // Compatibility window: a present, non-terminal state.json status is still
  // honored (plugin-written loops). When state.json is absent, the harness
  // process lifecycle + loop-written artifacts are the sole source of truth.
  // `phase` is never surfaced from any source (dropped, not replaced).
  const stateExists = job.statePath ? existsSync(job.statePath) : false;

  // Tracks whether the harness branch deliberately set `status`. A harness
  // resting state (notably AWAITING_USER on clean exit) is non-terminal but is
  // a fully-explained status, so the dead-process STOPPED finalizer below must
  // not reap it.
  let harnessDerived = false;

  if (stateExists && job.statePath) {
    const stateData = await readEffectiveStatusFromState(job.statePath);
    // Apply effective status from state.json for non-terminal jobs.
    // Terminal statuses (COMPLETED, FAILED, CANCELLED, STOPPED) set by the
    // process exit handler are authoritative and should not be overridden.
    if (
      stateData.status &&
      !isTerminalJobStatus(status) &&
      shouldApplyStateStatus(stateData.status, processRunning)
    ) {
      status = stateData.status;
    }
  } else if (
    job.claudeWorkDir &&
    (status === "RUNNING" || status === "AWAITING_USER")
  ) {
    // Harness branch: derive status from process lifecycle + required-artifact
    // presence + awaiting-signal inference. Scoped to a job that was actually
    // running (or already resting in AWAITING_USER) so QUEUED/STARTING ghost
    // expiry and CANCEL_PENDING finalization keep their own paths. Defer to the
    // live-exit handler if it still owns this job (no exit code recorded yet) so
    // we don't race it to a terminal status — mirrors the STOPPED suppression.
    const deferToLiveExit =
      job.exitCode == null && hasPendingLoopExit(job.loopId);
    if (!deferToLiveExit) {
      const searchDirs = collectArtifactSearchDirs(job);
      const requiredArtifactsPresent = areRequiredArtifactsPresent(
        job.command,
        searchDirs
      );
      const planFinalized =
        requiredArtifactsPresent && (taskProgress?.pending ?? 0) === 0;
      const awaitingSignalPresent = await detectAwaitingSignal({
        job,
        searchDirs,
        planFinalized,
        processRunning,
        exitCode: job.exitCode,
      });
      status = deriveHarnessJobStatus({
        exitCode: job.exitCode,
        processRunning,
        requiredArtifactsPresent,
        awaitingSignalPresent,
      });
      harnessDerived = true;
    }
  }

  // If the process is dead but the job isn't terminal yet, finalize it.
  // A live detached child can disappear from the process table before Node
  // delivers its exit event; suppress STOPPED while Desktop still owns that
  // child handle so the exit path can claim the job with exitCode first.
  // Skip when the harness branch already explained the status (e.g. a clean
  // exit resting in AWAITING_USER) — STOPPED would be a regression there.
  if (
    !(processRunning || isTerminalJobStatus(status) || harnessDerived) &&
    status !== "QUEUED" &&
    status !== "STARTING"
  ) {
    if (status === "CANCEL_PENDING") {
      status = "CANCELLED";
    } else if (!hasPendingLoopExit(job.loopId)) {
      status = "STOPPED";
    }
  }

  // Finalize QUEUED/STARTING jobs that never got a PID and are older than
  // 60 seconds. These are ghost entries from confirm steps where the loop
  // dispatch failed or was never delivered.
  if (
    (status === "QUEUED" || status === "STARTING") &&
    !processRunning &&
    job.pid == null
  ) {
    const ageMs = Date.now() - new Date(job.startedAt).getTime();
    if (ageMs > 60_000) {
      status = "FAILED";
    }
  }

  return {
    ...job,
    status,
    processRunning,
    taskProgress,
    currentTaskId,
    // Phase is no longer surfaced — progress is served by artifact-derived
    // taskProgress. Drop it explicitly so a legacy state.json phase or a
    // persisted job.phase never reaches the snapshot consumer.
    phase: undefined,
  };
}

// ---------------------------------------------------------------------------
// Harness-derived job status (no plugin state.json read)
// ---------------------------------------------------------------------------

/** Reserved marker a harness run prints to stdout when blocked on a human. */
const AWAITING_USER_SENTINEL = "<<AWAITING_USER>>";

export type HarnessStatusInputs = {
  exitCode?: number | null;
  processRunning: boolean;
  requiredArtifactsPresent: boolean;
  awaitingSignalPresent: boolean;
};

/**
 * Pure status derivation from the harness process lifecycle + loop-written
 * artifacts. Precedence (D-002): running > non-zero exit (crash) >
 * awaiting-signal > artifact-completeness > clean-exit-without-artifacts.
 */
export function deriveHarnessJobStatus(
  inputs: HarnessStatusInputs
): LocalJobStatus {
  if (inputs.processRunning) {
    return "RUNNING";
  }
  if (inputs.exitCode != null && inputs.exitCode !== 0) {
    // Crash / non-zero exit dominates regardless of artifacts written.
    return "FAILED";
  }
  if (inputs.awaitingSignalPresent) {
    // Clean exit but blocked on a human.
    return "AWAITING_USER";
  }
  if (inputs.requiredArtifactsPresent) {
    return "COMPLETED";
  }
  // Clean exit but missing a required artifact ⇒ failure.
  return "FAILED";
}

/**
 * Directories that may hold a job's loop-written artifacts. Mirrors the
 * live-exit validation in symphony-loop.ts (worktree first, then work dir) so
 * PLAN (work dir) and EXECUTE (worktree) both resolve.
 */
function collectArtifactSearchDirs(job: LocalJob): string[] {
  const dirs: string[] = [];
  if (job.worktreeDir) {
    dirs.push(job.worktreeDir);
  }
  if (job.claudeWorkDir) {
    dirs.push(job.claudeWorkDir);
  }
  return dirs;
}

/**
 * Whether every required artifact for a command is present in any search dir.
 * Reuses the ResultBundle manifest (SSOT) rather than hardcoding file names.
 */
function areRequiredArtifactsPresent(
  command: LocalJobCommand,
  searchDirs: string[]
): boolean {
  const manifest = ResultBundle[command as LoopCommand];
  if (!manifest || manifest.required.length === 0) {
    // No required artifacts ⇒ vacuously satisfied.
    return true;
  }
  return manifest.required.every((file) =>
    searchDirs.some((dir) => existsSync(path.join(dir, file)))
  );
}

/**
 * Harness-agnostic AWAITING_USER inference. Two independent signals so the
 * feature works even if one is absent (defense-in-depth):
 *   1. Artifact-presence (primary): open-questions.md exists AND the plan is
 *      not finalized. A cheap `existsSync` probe.
 *   2. Stream sentinel (fallback): the harness stream printed the reserved
 *      AWAITING_USER marker. Reading the stream is the expensive signal
 *      (a full-file tail read), so it is computed lazily and only when it
 *      could change the derived status: the primary signal hasn't already
 *      fired AND the process has exited cleanly. A live process resolves to
 *      RUNNING and a non-zero exit to FAILED regardless of the sentinel (see
 *      `deriveHarnessJobStatus` precedence), so the read is skipped there —
 *      which spares the high-frequency RUNNING poll path the file read.
 */
async function detectAwaitingSignal(params: {
  job: LocalJob;
  searchDirs: string[];
  planFinalized: boolean;
  processRunning: boolean;
  exitCode?: number | null;
}): Promise<boolean> {
  const artifactAwaiting =
    !params.planFinalized &&
    params.searchDirs.some((dir) =>
      existsSync(path.join(dir, LoopArtifactFile.OpenQuestions))
    );
  if (artifactAwaiting) {
    return true;
  }
  const isCrashExit = params.exitCode != null && params.exitCode !== 0;
  if (params.processRunning || isCrashExit) {
    return false;
  }
  return await readStreamTailForSentinel(params.job);
}

/**
 * Bounded read of the harness output stream (jsonl, then log) for the reserved
 * AWAITING_USER sentinel. Reuses readLogTail rather than duplicating file IO.
 */
async function readStreamTailForSentinel(job: LocalJob): Promise<boolean> {
  for (const streamPath of [job.jsonlPath, job.logPath]) {
    if (!streamPath) {
      continue;
    }
    const tail = await readLogTail(streamPath);
    if (tail?.includes(AWAITING_USER_SENTINEL)) {
      return true;
    }
  }
  return false;
}
