import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";

export type AgentSessionFeatureIdentity = FeatureFlagIdentity;

export function isAgentSessionSyncSupportedForUser(
  identity: AgentSessionFeatureIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
    identity,
    "agent_session_feature_flag_unavailable"
  );
}

/** @deprecated Use isAgentSessionSyncSupportedForUser — single flag for both sync and monitoring. */
export const isAgentMonitoringEnabledForUser =
  isAgentSessionSyncSupportedForUser;
