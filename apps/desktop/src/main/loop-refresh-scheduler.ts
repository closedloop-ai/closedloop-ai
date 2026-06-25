import { gatewayLog } from "./gateway-logger.js";
import { type LoopSchedulerDeps, parseEnvMs } from "./loop-lifecycle.js";
import { refreshLoopToken } from "./loop-refresh.js";

// ---------------------------------------------------------------------------
// Default refresh skew: 30 minutes in milliseconds
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_SKEW_MS = 30 * 60 * 1000;

export const getRefreshSkewMs = (): number =>
  parseEnvMs("CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS", DEFAULT_REFRESH_SKEW_MS);

// ---------------------------------------------------------------------------
// Shared tick logic (exported so LoopSchedulerContext can reuse it)
// ---------------------------------------------------------------------------

/**
 * Runs one refresh tick. `rescheduleFn` is called with the new expiry when
 * the refresh succeeds and returns an expiresAt, so the caller can schedule
 * the next timeout against whichever timer registry owns this loop.
 */
export async function runRefreshTick(
  loopId: string,
  deps: LoopSchedulerDeps,
  rescheduleFn: (expiresAt: number) => void
): Promise<void> {
  gatewayLog.info(
    "refresh-scheduler",
    `Proactive refresh tick for loopId=${loopId}`
  );

  const result = await refreshLoopToken(
    loopId,
    deps.apiBaseUrl,
    deps.getToken,
    deps.loopTokenStore
  );

  if (!result.success) {
    gatewayLog.warn(
      "refresh-scheduler",
      `Proactive refresh failed for loopId=${loopId}: ${result.error}; not rescheduling`
    );
    return;
  }

  const { expiresAt } = result.meta;

  if (expiresAt === undefined) {
    // New token is opaque — cannot compute the next refresh time.
    gatewayLog.info(
      "refresh-scheduler",
      `Refresh succeeded for loopId=${loopId} but new token has no expiresAt; not rescheduling`
    );
    return;
  }

  rescheduleFn(expiresAt);
}
