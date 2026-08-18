/**
 * @file sync-lane-contract.ts
 * @description The node-free contract shared by every desktop→cloud sync lane
 * that owns a durable OUTBOX (PLN-1562 WS1).
 *
 * Two lanes persist "what still owes delivery to the cloud" as outbox rows —
 * the per-session metadata lane (`agent_session_sync_outbox`, FEA-3473) and the
 * agent-component invocation parts lane (`agent_component_invocation_sync_outbox`).
 * Both were written to the SAME crash-correct discipline (advance/clear only on a
 * VERIFIED server ack, bounded retry, dead-letter instead of silent drop), and
 * both had declared their own private copy of the identical two-member status
 * union. Those copies are replaced by {@link OutboxStatus} here so the vocabulary
 * cannot drift lane-to-lane.
 *
 * Values only — the MECHANICS that operate on them live in
 * `main/sync/durable-outbox.ts`. It sits in `shared/` and is node-free (no
 * imports at all) to match the `transcript-sync-status-contract.ts` precedent
 * for lane vocabularies, though every consumer today is main-process; that keeps
 * the option of a renderer-side reader open without a later move.
 *
 * NOT every sync lane is an outbox: the transcript archive lane
 * (`TranscriptSyncState`) is a per-file protocol LEDGER with its own five-state
 * vocabulary (`idle`/`queued`/`uploading`/`failed`/`dead`) and the trace-comment
 * lane keeps CRUD-aware status ON the entity row. Those vocabularies are
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
 */
export const OutboxStatus = {
  Pending: "pending",
  DeadLettered: "dead_lettered",
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
  if (value === OutboxStatus.Pending || value === OutboxStatus.DeadLettered) {
    return value;
  }
  return null;
}
