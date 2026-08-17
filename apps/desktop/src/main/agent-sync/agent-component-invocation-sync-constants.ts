/** Local latest-generation template written by invocation materialization. */
export const AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY =
  "agent_component_invocations" as const;
export const AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID =
  "__invocation_sync_state__" as const;
export const AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID =
  "__invocation_sync_backfill__" as const;

/** Durable delivery key for one authenticated compute target. */
export function buildAgentComponentInvocationSyncSourceKey(
  computeTargetId: string
): string {
  return `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:${computeTargetId}`;
}

// PLN-1562: this lane's outbox status USED to be declared here as a private
// two-member const identical to the per-session lane's. Both are replaced by the
// shared `OutboxStatus` in `shared/sync-lane-contract.ts`; consumers import it
// directly. Semantics unchanged.

export const AgentComponentInvocationSyncLocalError = {
  GenerationItemLimitExceeded: "generation_item_limit_exceeded",
  GenerationWireLimitExceeded: "generation_wire_limit_exceeded",
  InvalidPersistedPayload: "invalid_persisted_payload",
  /**
   * ISS-4976 (@wongk review): the producer ran the SHARED
   * `agentComponentInvocationSyncPartSchema` over the part it just built and the
   * part failed it. The cloud would have answered 400 → `validation_failed` →
   * dead-letter after five pointless round trips, so the generation is
   * dead-lettered here instead, with the failing path recorded locally.
   */
  WirePayloadContractViolation: "wire_payload_contract_violation",
} as const;
export type AgentComponentInvocationSyncLocalError =
  (typeof AgentComponentInvocationSyncLocalError)[keyof typeof AgentComponentInvocationSyncLocalError];
