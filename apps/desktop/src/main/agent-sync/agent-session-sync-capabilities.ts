import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import type { AgentSessionSyncServiceOptions } from "./agent-session-sync-service-options.js";
import { buildAgentSessionSyncSourceKey } from "./agent-session-sync-source.js";

export type AgentSessionSyncCapabilities = {
  compression: boolean;
  activityChunking: boolean;
  monitoredActivity: boolean;
};

export const NO_AGENT_SESSION_SYNC_CAPABILITIES: AgentSessionSyncCapabilities =
  {
    compression: false,
    activityChunking: false,
    monitoredActivity: false,
  };

/** Capture one immutable capability snapshot for a complete sync attempt. */
export function captureAgentSessionSyncCapabilities(
  options: AgentSessionSyncServiceOptions
): AgentSessionSyncCapabilities {
  return {
    compression: options.isSyncCompressionSupported?.() ?? false,
    activityChunking: options.isSyncActivityChunkingSupported?.() ?? false,
    monitoredActivity: options.isSyncMonitoredActivitySupported?.() ?? false,
  };
}

/** Resolve the revisioned durable cursor identity from live negotiation state. */
export function resolveAgentSessionSyncSourceKey(
  options: AgentSessionSyncServiceOptions
): string | null {
  const computeTargetId = options.getSyncComputeTargetId?.() ?? null;
  return computeTargetId
    ? buildAgentSessionSyncSourceKey(
        computeTargetId,
        captureAgentSessionSyncCapabilities(options).monitoredActivity
      )
    : null;
}

/** Normalize a hello-ack capability bag into the Desktop's live snapshot. */
export function capabilitiesFromHelloAck(
  capabilities: ComputeTargetServerCapabilities | undefined
): AgentSessionSyncCapabilities {
  return {
    compression: capabilities?.agentSessionSyncCompression === true,
    activityChunking: capabilities?.agentSessionSyncActivityChunking === true,
    monitoredActivity: capabilities?.agentSessionSyncMonitoredActivity === true,
  };
}

/** Shared capability helpers for app negotiation and sync-attempt snapshots. */
export const SessionSyncCapability = {
  None: NO_AGENT_SESSION_SYNC_CAPABILITIES,
  capture: captureAgentSessionSyncCapabilities,
  sourceKey: resolveAgentSessionSyncSourceKey,
  fromHelloAck: capabilitiesFromHelloAck,
} as const;
