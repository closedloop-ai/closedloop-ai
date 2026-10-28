import type {
  AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";

export type LaneStallOriginRead =
  | { kind: "valid"; stalledSinceMs: number }
  | { kind: "absent"; stalledSinceMs: null }
  | { kind: "invalid" };

/** Returns whether an acknowledgement names the exact queued invocation part. */
export function ackMatchesPart(
  ack: AgentComponentInvocationSyncAck,
  part: AgentComponentInvocationSyncPart
): boolean {
  return (
    ack.externalGenerationId === part.externalGenerationId &&
    ack.partIndex === part.partIndex &&
    ack.partHash === part.partHash
  );
}

/** Reads the persisted lane-stall origin without inventing a fallback instant. */
export function readLaneStallOrigin(value: string | null): LaneStallOriginRead {
  if (value === null) {
    return { kind: "absent", stalledSinceMs: null };
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? { kind: "valid", stalledSinceMs: parsed }
    : { kind: "invalid" };
}
