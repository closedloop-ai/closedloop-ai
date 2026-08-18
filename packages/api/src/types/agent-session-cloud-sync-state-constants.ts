/**
 * FEA (PRD-536 E6): the per-ROW local-vs-cloud sync disclosure — the Zod-FREE
 * constants half. The plain const-object enum, its union type, values tuple, and
 * type guard live here so client bundles that only need the enum for a
 * comparison/render (e.g. `SyncedSessionsTable`, imported by the dashboard,
 * insights, and telemetry mini-tables) do NOT pull `zod` in transitively. The
 * strict boundary schema lives in the sibling `agent-session-cloud-sync-state`
 * module, which imports these constants (codex #3449 review: split the badge
 * constants out of Zod-backed modules).
 *
 * Unlike `ReadSource` — a RESPONSE-level discriminator that stamps the WHOLE
 * list with which store produced it (in desktop/local mode every row reads
 * `Local`, so no single row can distinguish local-only from already-cloud-
 * mirrored) — this is a per-item signal: is THIS session still pending upload to
 * the cloud, or has the cloud already acked it?
 *
 * `pending` = the session is enqueued in the local sync outbox but not yet acked
 * by the server (its id is in `loadPendingOutboxIds(sourceKey)`), so the cloud
 * copy may be missing or behind — an honest "local-only, cloud may be behind"
 * per row. `synced` = not pending: the local outbox has no un-acked entry for it
 * (verified server ack cleared the row), or the row was read from the cloud
 * store, which by definition holds already-synced sessions.
 *
 * Additive + optional on the row type: a version-skewed producer that doesn't
 * project it omits the key, and consumers treat a missing/`undefined` value as
 * "unknown — render no per-row disclosure" rather than guessing `pending`.
 */
export const AgentSessionCloudSyncState = {
  /**
   * Enqueued in the local sync outbox but not yet server-acked: the cloud copy
   * of this session may be missing or stale. Drives the per-row local-only badge.
   */
  Pending: "pending",
  /**
   * No un-acked local outbox entry for this session (verified ack cleared it) or
   * the row was read from the cloud store — the cloud is caught up for this row.
   */
  Synced: "synced",
} as const;
export type AgentSessionCloudSyncState =
  (typeof AgentSessionCloudSyncState)[keyof typeof AgentSessionCloudSyncState];

export const agentSessionCloudSyncStateValues = Object.values(
  AgentSessionCloudSyncState
) as [AgentSessionCloudSyncState, ...AgentSessionCloudSyncState[]];

/** Type guard: narrows an arbitrary value to a known `AgentSessionCloudSyncState`. */
export function isAgentSessionCloudSyncState(
  value: unknown
): value is AgentSessionCloudSyncState {
  return (
    typeof value === "string" &&
    (agentSessionCloudSyncStateValues as readonly string[]).includes(value)
  );
}

/**
 * Compile-time exhaustiveness guard (AGENTS.md "Exhaustiveness"): every member
 * of the `AgentSessionCloudSyncState` union must be covered here. Adding a new
 * member to the const-object enum without extending this map fails `tsc`,
 * mirroring the `readSource` convention. Runtime no-op.
 */
function assertCloudSyncStateKeysCovered(
  _covered: Record<AgentSessionCloudSyncState, true>
): void {
  /* type-level check only */
}
assertCloudSyncStateKeysCovered({
  pending: true,
  synced: true,
});
