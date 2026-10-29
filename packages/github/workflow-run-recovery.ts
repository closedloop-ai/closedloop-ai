// The run point read and the two writes behind the never-scheduled
// auto-recovery (ISS-11040). The decision of WHEN to call them lives with the
// caller; this module only talks to GitHub and reports what it said.
//
// Requires `actions: write` on the App installation for the cancel and the
// re-run, and `actions: read` for the point read — the scope
// `never-scheduled-runs.ts` already relies on to detect the stall.

import "server-only";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { extractGitHubErrorStatus } from "./error-status";
import { UNNAMED_WORKFLOW } from "./never-scheduled-runs";

/** The status a cancel ends in; the recovery sends its re-run only from here. */
export const COMPLETED_RUN_STATUS = "completed";

const WorkflowRunStateSchema = z.object({
  status: z.string(),
  /**
   * Optional in GitHub's own schema, REQUIRED here: the recovery bound is read
   * off it, so a run whose attempt cannot be read must parse as unreadable and
   * never be acted on.
   */
  run_attempt: z.number().int().positive(),
});

export type WorkflowRunState = {
  /** GitHub's `status` verbatim — `queued`, `in_progress`, `completed`, … */
  status: string;
  /** 1 for the original attempt; every re-run increments it on the same id. */
  runAttempt: number;
};

/** One run's live status and attempt, or NULL when that could not be read. */
export async function getWorkflowRunState(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowRunState | null> {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      { owner, repo, run_id: runId }
    );
    const parsed = WorkflowRunStateSchema.safeParse(response.data);
    return parsed.success
      ? { status: parsed.data.status, runAttempt: parsed.data.run_attempt }
      : null;
  } catch {
    return null;
  }
}

export type WorkflowRunWriteResult =
  | { ok: true }
  /** `detail` carries GitHub's status and message so the failure is actionable. */
  | { ok: false; detail: string };

/** `POST …/cancel` — GitHub answers 202 and completes the cancel asynchronously. */
export async function cancelWorkflowRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowRunWriteResult> {
  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
      { owner, repo, run_id: runId }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: writeFailureDetail(error) };
  }
}

/**
 * `POST …/rerun` — a new attempt on the SAME run id, for the same head SHA and
 * the same triggering event, which is what lets `run_attempt` count recoveries.
 */
export async function rerunWorkflowRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowRunWriteResult> {
  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
      { owner, repo, run_id: runId }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: writeFailureDetail(error) };
  }
}

function writeFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = extractGitHubErrorStatus(error);
  return status === null ? message : `HTTP ${status}: ${message}`;
}

/** The conclusion a cancel ends in. */
export const CANCELLED_RUN_CONCLUSION = "cancelled";

/** One run on a head SHA, as the stranded re-report needs to judge it (ISS-11040). */
export type HeadWorkflowRun = {
  id: number;
  /** Stable across renames, unlike `workflow`, so it is what "the same workflow" compares. */
  workflowId: number;
  /** Per workflow and increasing: a higher number on the same workflow is a later run. */
  runNumber: number;
  workflow: string;
  runAttempt: number;
  conclusion: string | null;
};

/** One head SHA carries a few runs per workflow, a few dozen at most. */
const HEAD_RUNS_PAGE_SIZE = 100;

const HeadRunsResponseSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      workflow_id: z.number().int(),
      run_number: z.number().int().positive(),
      name: z.string().nullable(),
      /** Required, as on the point read: the attempt decides whether it is ours to report. */
      run_attempt: z.number().int().positive(),
      conclusion: z.string().nullable(),
    })
  ),
});

/**
 * Every run on ONE head SHA, whatever its status, or NULL when that could not
 * be read.
 *
 * All statuses, not just cancelled ones, because a cancelled run only counts
 * as stranded when no later run of its workflow replaced it on that head.
 * Asked per head rather than repository-wide: the repository's newest 100
 * cancelled runs spanned under 11 hours on 2026-09-24 (6,198 in total), and a
 * stranded PR can sit for days, so a repository page would drop it long before
 * anyone unblocked it.
 */
export async function listRunsOnHead(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
): Promise<HeadWorkflowRun[] | null> {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      { owner, repo, head_sha: headSha, per_page: HEAD_RUNS_PAGE_SIZE }
    );
    const parsed = HeadRunsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.workflow_runs.map((run) => ({
      id: run.id,
      workflowId: run.workflow_id,
      runNumber: run.run_number,
      workflow: run.name ?? UNNAMED_WORKFLOW,
      runAttempt: run.run_attempt,
      conclusion: run.conclusion,
    }));
  } catch {
    return null;
  }
}
