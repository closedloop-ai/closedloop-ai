/**
 * @file sync-lane-contract.ts
 * @description The node-free contract shared by every desktop→cloud sync lane
 * that owns a durable OUTBOX (PLN-1562 WS1).
 *
 * Outbox-shaped lanes persist "what still owes delivery to the cloud" as rows:
 * the per-session metadata lane (`agent_session_sync_outbox`, FEA-3473) and the
 * agent-component invocation parts lane
 * (`agent_component_invocation_sync_outbox`). Both started with private copies
 * of the identical two-member status union and now import {@link OutboxStatus}
 * so the vocabulary cannot drift lane-to-lane.
 *
 * Values only — the MECHANICS that operate on them live in
 * `main/sync/durable-outbox.ts`. It sits in `shared/` and is node-free (no
 * imports at all) to match the `transcript-sync-status-contract.ts` precedent
 * for lane vocabularies, though every consumer today is main-process; that keeps
 * the option of a renderer-side reader open without a later move.
 *
 * NOT every sync lane is an outbox: the transcript archive lane
 * (`TranscriptSyncState`) is a per-file protocol LEDGER with its own five-state
 * vocabulary (`idle`/`queued`/`uploading`/`failed`/`dead`). That vocabulary is
 * intentionally NOT folded in here — see `main/sync/AGENTS.md`.
 */

/**
 * The durable outbox status shared by every outbox-shaped lane.
 *
 * - `pending` — enqueued for delivery, not yet acked by the server. The row is
 *   CLEARED only on a verified ack, never on send, so a kill mid-flight resumes
 *   per item instead of re-walking the whole corpus.
 * - `dead_lettered` — intentionally abandoned this run (oversize, validation
 *   failure, exhausted retry budget, unhydratable after enqueue). Recorded rather
 *   than dropped, so the watermark can advance past it and a recovery pass can
 *   still re-drive it.
 * - `withheld` (ISS-7246) — nothing worth sending YET. The session exists
 *   locally but is not substantive (a `SessionStart` row with no turn, token, or
 *   tool use), so no lane owes it and no drain should select it. Distinct from
 *   `dead_lettered` on purpose, and the distinction is operational: a
 *   dead-letter is "we tried and gave up", is subject to the dead-letter
 *   recovery lifecycle, and counts against a retry budget; a withheld row was
 *   never attempted, carries no budget, and returns to `pending` only when the
 *   local session gains new activity. Both are recorded rather than deleted, so
 *   the retention sweep's status-agnostic undelivered probe still defers a purge
 *   of the underlying session.
 */
export const OutboxStatus = {
  Pending: "pending",
  DeadLettered: "dead_lettered",
  Withheld: "withheld",
} as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

/**
 * Narrow a persisted status string to an {@link OutboxStatus}, or `null` when it
 * is neither member. The `status` column is unconstrained TEXT in both outbox
 * tables (SQLite, no CHECK), so a row written by a newer/older build — or a
 * hand-edited store — can carry anything; callers decide the fallback rather than
 * inheriting a silent mislabel.
 */
export function asOutboxStatus(value: string): OutboxStatus | null {
  if (
    value === OutboxStatus.Pending ||
    value === OutboxStatus.DeadLettered ||
    value === OutboxStatus.Withheld
  ) {
    return value;
  }
  return null;
}
