/** Local latest-generation template written by invocation materialization. */
export const AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY =
  "agent_component_invocations" as const;
export const AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID =
  "__invocation_sync_state__" as const;
export const AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID =
  "__invocation_sync_backfill__" as const;
/**
 * ISS-5855: the sentinel `external_session_id` under which the store-integrity
 * probe keeps the instant through which it has SCANNED this lane's outbox
 * (`database/invocation-sync-integrity-observation.ts`).
 *
 * A third sentinel in `agent_component_invocation_sync_cursors` rather than a new
 * table, for the reason the first two are there: that table already IS this lane's
 * durable key/value state, keyed `(source_key, external_session_id)`, and the one
 * query that enumerates rows by `source_key` alone
 * (`loadPendingInvocationTemplates`) is guarded by an `EXISTS` over the outbox, so
 * a sentinel with no delivery rows behind it is filtered out — which is exactly
 * what already keeps `__invocation_sync_state__` from being mistaken for a session.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID =
  "__invocation_sync_integrity__" as const;

/**
 * The prefix that separates a target-scoped DELIVERY key from the unscoped
 * template key, for the readers that must select one kind and not the other.
 *
 * Declared once because every consumer must use it as a `startsWith` and never as
 * a raw `LIKE` pattern: the template key contains `_`, which `LIKE` reads as a
 * single-character wildcard, so a hand-written pattern silently widens the scan.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX =
  `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:` as const;

/** Durable delivery key for one authenticated compute target. */
export function buildAgentComponentInvocationSyncSourceKey(
  computeTargetId: string
): string {
  return `${AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX}${computeTargetId}`;
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
   * ISS-4976 (@whitlockk review): the producer ran the SHARED
   * `agentComponentInvocationSyncPartSchema` over the part it just built and the
   * part failed it. The cloud would have answered 400 → `validation_failed` →
   * dead-letter after five pointless round trips, so the generation is
   * dead-lettered here instead, with the failing path recorded locally.
   */
  WirePayloadContractViolation: "wire_payload_contract_violation",
  /**
   * PRD-699: one of the durable retry bookkeeping counters could not be read as a
   * non-negative safe integer, so the lane cannot budget the row honestly.
   */
  InvalidPersistedDurabilityState: "invalid_persisted_durability_state",
  /**
   * ISS-6889 (codex P1 review): two of the generation's stored invocation ids
   * canonicalize to the same `externalInvocationId`, so the generation cannot
   * name its own items and no canonical hash exists for it.
   *
   * It is a reason of its own rather than {@link WirePayloadContractViolation}
   * because the cause is different and an operator acts on it differently: that
   * one means the part failed the shared schema, this one means two SOURCE rows
   * collided under the trim the wire boundary applies. Folding it into the
   * generic reason would hide the only signal that says the collector minted
   * whitespace-distinguished ids.
   */
  DuplicateInvocationId: "duplicate_invocation_id",
  /**
   * ISS-6209: the row's persisted `created_at` could not be parsed, so the
   * `session_missing` horizon that decides when this lane may stop retrying could
   * not be evaluated at all. Recorded as the row's `last_error` INSTEAD of the ack
   * reason, because the ack reason (`session_missing`) describes what the cloud
   * said while this describes why the lane quarantined the row — and only the
   * second one tells an operator the local store is corrupt.
   */
  CorruptCreatedAt: "corrupt_created_at",
  /**
   * ISS-5855: the part spent its whole `session_missing` horizon
   * ({@link import("./invocation-sync-rejection-policy.js").SESSION_MISSING_MAX_RETRY_AGE_MS})
   * without its parent session ever reaching the cloud, so the lane abandoned it
   * through the age-budgeted terminal path. It is not eligible for in-place
   * recovery; a later materialization path may supersede it with a fresh row.
   *
   * Recorded as the row's `last_error` INSTEAD of the ack reason for the same
   * reason {@link CorruptCreatedAt} is: `session_missing` is what the cloud said
   * on ONE attempt and it is also what every still-retrying row carries, so it
   * cannot distinguish a row that is deferring from a row the lane gave up on.
   * This marker names the lane's own terminal CAUSE, which is what makes the loss
   * selectable by the store-integrity probe that reports it
   * (`database/invocation-sync-outbox-integrity.ts`).
   */
  SessionMissingHorizonExhausted: "session_missing_horizon_exhausted",
  /**
   * PRD-699 F8: the row sat in one unbroken lane-wide environmental failure run
   * until the shared wall-clock ceiling was spent. No row-attributable retry
   * budget was charged, so recovery re-pends it with counters preserved.
   */
  EnvironmentalStallExhausted: "environmental_stall_exhausted",
} as const;
export type AgentComponentInvocationSyncLocalError =
  (typeof AgentComponentInvocationSyncLocalError)[keyof typeof AgentComponentInvocationSyncLocalError];

/**
 * ISS-6209: the delivery/template outbox table, named once so the sync lane's
 * quarantine log and the store-integrity check that reports the same corruption
 * (`database/invocation-sync-outbox-integrity.ts`) cannot drift apart. The
 * integrity issue's `object` field carries this value, and `object` is a schema
 * identifier that reaches Datadog — so it must be the real table name.
 */
export const AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE =
  "agent_component_invocation_sync_outbox" as const;
