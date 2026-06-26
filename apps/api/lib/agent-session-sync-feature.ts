import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

export type AgentSessionFeatureIdentity = {
  userId: string;
  clerkUserId?: string | null;
};

function resolveDistinctIds(identity: AgentSessionFeatureIdentity): string[] {
  return [
    ...new Set(
      [identity.clerkUserId, identity.userId].filter((value): value is string =>
        Boolean(value)
      )
    ),
  ];
}

async function isFeatureEnabledForIdentity(
  featureFlag: string,
  identity: AgentSessionFeatureIdentity
): Promise<boolean> {
  try {
    for (const distinctId of resolveDistinctIds(identity)) {
      if (
        (await isFeatureFlagEnabledForDistinctId(featureFlag, distinctId)) ===
        true
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    log.warn("agent_session_feature_flag_unavailable", {
      featureFlag,
      error: parseError(error),
    });
    return false;
  }
}

export function isAgentSessionSyncSupportedForUser(
  identity: AgentSessionFeatureIdentity
): Promise<boolean> {
  return isFeatureEnabledForIdentity(
    DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
    identity
  );
}

/** @deprecated Use isAgentSessionSyncSupportedForUser — single flag for both sync and monitoring. */
export const isAgentMonitoringEnabledForUser =
  isAgentSessionSyncSupportedForUser;
