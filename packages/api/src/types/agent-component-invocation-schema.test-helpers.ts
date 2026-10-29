import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "./agent-component-invocation.ts";

/** A minimal valid v1 sync part carrying `items`, for schema suites. */
export function part(items: unknown[]) {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: "session-1",
    externalGenerationId: "a".repeat(64),
    sourceUpdatedAt: "2026-07-22T16:00:00.000Z",
    dataRevision: 35,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    partHash: "c".repeat(64),
    items,
  };
}

/** A minimal valid tool-kind item, for schema suites. */
export function item(externalInvocationId: string) {
  return {
    externalInvocationId,
    sourceSessionId: "session-1",
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-07-22T16:00:00.000Z",
    sequence: 0,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}
