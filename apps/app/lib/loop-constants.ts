import { LoopStatus } from "@repo/api/src/types/loop";

// Statuses that allow a loop to be restarted. Intentionally excludes COMPLETED — UI restricts restart to failed/timed-out only.
export const RESTARTABLE_LOOP_STATUSES = new Set<LoopStatus>([
  LoopStatus.Failed,
  LoopStatus.TimedOut,
]);
