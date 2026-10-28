/** ISS-6031 follow-up: outbox rows stranded under a RETIRED compute target. */
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";

const TAG = "agent-session-sync";

/**
 * Best-effort: a failure leaves the rows stranded and still owed, and the next
 * hydration re-attempts. It must never fail the hydration that calls it — a
 * device that cannot migrate its history still has to sync its live sessions.
 */
export async function adoptStrandedOutboxRows(
  source: AgentSessionSyncSource,
  sourceKey: string | null,
  options: {
    getSyncIdentity?: () => SignedInUserIdentity | null;
    /** ISS-7096: normalized apiOrigin of the active saved config, or null. */
    getActiveEnvironmentKey?: () => string | null;
  }
): Promise<void> {
  const identity = options.getSyncIdentity?.() ?? null;
  // No lane to adopt onto, or no ownership proof.
  if (
    !(sourceKey && identity && source.adoptOutboxRowsFromRetiredComputeTargets)
  ) {
    return;
  }
  try {
    const adoption = await source.adoptOutboxRowsFromRetiredComputeTargets(
      sourceKey,
      identity,
      options.getActiveEnvironmentKey?.() ?? null
    );
    if (adoption.adoptedIds.length > 0) {
      gatewayLog.info(
        TAG,
        `adopted ${adoption.adoptedIds.length} outbox row(s) owed to the cloud from ${adoption.retiredSourceKeys} retired compute target(s); they were unreachable under this device's source key`
      );
    }
    if (adoption.parkedRows > 0) {
      // ISS-7096: another identity's rows moved into that identity's parked
      // partition. Info, not warn — on a multi-environment device this is the
      // supported workflow, and the rows sync when their environment is active.
      gatewayLog.info(
        TAG,
        `parked ${adoption.parkedRows} outbox row(s) owned by another account — they will sync when their own environment is active`
      );
    }
    if (adoption.declined > 0) {
      // These rows ARE owed and are left in place on purpose; silence here
      // would read identically to having nothing to do.
      gatewayLog.warn(
        TAG,
        `left ${adoption.declined} stranded outbox row(s) unadopted — their sessions have no provable owner`
      );
    }
  } catch (error) {
    gatewayLog.warn(
      TAG,
      `failed to adopt stranded outbox rows: ${errorMessage(error)}`
    );
  }
}
