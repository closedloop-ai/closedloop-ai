/**
 * @file scheduled-review-dispatch.ts
 * @description FEA-4143 (PRD-553 / PLN-1500) Slice 1 — the crewd `Dispatch` the
 * desktop daemon runs, replacing the M1 `m1SkipDispatch` no-op.
 *
 * This factory runs in the db-host child (where the daemon ticks). For a
 * `review`-kind task carrying a valid night-crew config (see
 * `@repo/crewd/night-crew-config`), it does NOT execute the harness cascade here
 * — the child has neither the access token nor the shell PATH, and must never
 * run against the live checkout. Instead it PROXIES the run to main via the
 * injected `runReview` seam, which composes it through the on-demand
 * `AuditService` (throwaway-workspace copy + main-side credentials). Everything
 * else — a non-review task, or a review task with no/invalid config — degrades
 * to the same recorded `skipped` run the M1 no-op produced, so the tick never
 * crashes and an unconfigured task still fires + persists a run row.
 */

import {
  type Dispatch,
  type DispatchContext,
  PassKind,
  RunStatus,
  readNightCrewConfig,
  type ScheduledTask,
} from "@repo/crewd";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../../shared/scheduled-review-contract.js";

/** The main-side proxy seam: post a scheduled review to main and await its result. */
export type ScheduledReviewRunner = (
  request: ScheduledReviewRequest
) => Promise<ScheduledReviewResult>;

/**
 * Build the daemon dispatch. `runReview` is the child→main proxy (undefined ⇒ no
 * review runner wired, so every task degrades to a recorded skip, preserving the
 * pre-FEA-4143 behavior). Non-review tasks are always skipped here — this slice
 * wires only the `review` pass; other pass kinds stay under the blocked umbrella.
 */
export function createScheduledReviewDispatch(
  runReview: ScheduledReviewRunner | undefined
): Dispatch {
  return (task: ScheduledTask, ctx: DispatchContext) =>
    dispatchReview(task, ctx, runReview);
}

async function dispatchReview(
  task: ScheduledTask,
  _ctx: DispatchContext,
  runReview: ScheduledReviewRunner | undefined
): ReturnType<Dispatch> {
  if (task.kind !== PassKind.Review || !runReview) {
    return skip(
      task,
      runReview
        ? `non-review task '${task.name}' (kind=${task.kind}) — scheduled dispatch only wires the review pass`
        : `scheduled '${task.name}' fired but no review runner is wired — no-op`
    );
  }

  const config = readNightCrewConfig(task.meta);
  if (!config) {
    return skip(
      task,
      `review task '${task.name}' has no valid night-crew config on meta — skipped`
    );
  }

  const request: ScheduledReviewRequest = {
    repoDir: config.repoDir,
    characters: config.characters,
    ...(config.projectSlug === undefined
      ? {}
      : { projectSlug: config.projectSlug }),
    ...(config.assigneeId === undefined
      ? {}
      : { assigneeId: config.assigneeId }),
    ...(config.cascade === undefined ? {} : { cascade: config.cascade }),
  };

  const result = await runReview(request);
  return {
    status: result.ok ? RunStatus.Success : RunStatus.Failed,
    harnessUsed: null,
    attempts: [],
    summary: result.summary,
    error: result.error,
  };
}

/** A recorded `skipped` run (fires + persists, spawns nothing) — the M1 shape. */
function skip(_task: ScheduledTask, summary: string): ReturnType<Dispatch> {
  return Promise.resolve({
    status: RunStatus.Skipped,
    harnessUsed: null,
    attempts: [],
    summary,
    error: null,
  });
}
