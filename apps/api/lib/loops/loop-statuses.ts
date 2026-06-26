import { LoopStatus } from "@repo/api/src/types/loop";

/**
 * Loop statuses that the partial unique index
 * `loops_active_artifact_command_version_key` treats as currently holding an
 * `(artifact_id, command, artifact_version)` slot. This is the DB
 * index-blocking tier; the narrower operationally-active tier lives in
 * `findOperationallyActiveLoop`.
 *
 * Keep this list shared between loop creation, runner authentication, and loop
 * callback services so lifecycle gates do not drift as timeout and recovery
 * behavior evolves.
 */
export const ACTIVE_LOOP_STATUSES: LoopStatus[] = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

/**
 * Statuses that can still accept late runner-owned callbacks. The terminal
 * statuses cover races where the timeout/cancel/failure path wins before the
 * runner's final callback arrives.
 */
export const RUNNER_REQUEST_PINNABLE_STATUSES: LoopStatus[] = [
  ...ACTIVE_LOOP_STATUSES,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
];

export function isRunnerRequestPinnableStatus(status: string): boolean {
  return RUNNER_REQUEST_PINNABLE_STATUSES.some(
    (pinnableStatus) => pinnableStatus === status
  );
}
