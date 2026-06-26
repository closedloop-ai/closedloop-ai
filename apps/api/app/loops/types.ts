import type { LoopStatus } from "@repo/api/src/types/loop";

/**
 * Response shape for GET /api/loops/:id/runtime (admin-only).
 * Contains auth lifecycle fields and parsed runner capability flags.
 */
export type LoopRuntimeState = {
  id: string;
  status: LoopStatus;
  tokenExpiresAt: Date | null;
  lastRunnerHeartbeatAt: Date | null;
  activeTokenJti: string | null;
  runnerCapabilities: {
    loopRunnerRefreshSupported: boolean;
    loopRunnerHeartbeatSupported: boolean;
  };
};
