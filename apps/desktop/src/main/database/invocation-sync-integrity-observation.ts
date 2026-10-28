/**
 * @file invocation-sync-integrity-observation.ts
 * @description ISS-5855 (codex review) — the DURABLE record of how far the
 * store-integrity probe has scanned this lane's outbox, so a parked row cannot age
 * out of its report window without ever having been looked at.
 *
 * ## The hole this closes
 *
 * `INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS` is measured from the instant
 * a row was PARKED, and that is the only clock the probe had. The window is
 * deliberate and must stay — nothing guarantees a dead-lettered row is ever removed,
 * so an unbounded rule pins the store permanently unhealthy for any session that
 * goes quiet — but "24h after it happened" is not the same promise as "24h after
 * anyone saw it". Desktop can dead-letter a part, exit before the probe's five-minute
 * first run, and stay closed or asleep for longer than the window; the first probe
 * after restart then discards the row on age alone and no monitored event is ever
 * emitted. The abandonment survives only as a main-process log line from a process
 * that has already exited, which is the same silent loss both this ticket and
 * ISS-6209 exist to close.
 *
 * ## What is stored, and why one scalar rather than a per-row marker
 *
 * One instant: the `nowMs` of the last COMPLETED scan. A parked row is UNREPORTED
 * exactly when it was parked at or after that instant, because the scan that
 * advanced the marker either saw it or did not exist. That is enough to give the
 * window its missing precondition — report at least once, then age out normally —
 * without a schema change, a write per reported row, or a second timestamp column
 * whose meaning would have to be kept in step with `updated_at`.
 *
 * It is deliberately not `Date.now()` read here: the caller's `nowMs` is captured
 * BEFORE the scan opens its read snapshot, so a row parked concurrently with the
 * scan compares as unreported and is picked up next run. Recording the instant the
 * scan finished would let exactly that row be marked observed without having been.
 *
 * ## Absent marker means "never scanned", and that is load-bearing
 *
 * A store with no marker is one no build of this probe has ever swept — the first
 * run after upgrading into this build. Its parked rows are unreported by definition,
 * including the ones an earlier build left behind under the legacy `session_missing`
 * marker, so that first run reports them once regardless of age and then behaves
 * normally forever after. Widening the fetch for that one run is what makes the
 * legacy alias in `invocation-sync-outbox-integrity.ts` mean anything: without it the
 * alias would recognise rows the query had already excluded on age.
 *
 * The write is MONOTONE. A clock that moves backwards must not un-observe rows that
 * were already reported, which would re-raise a settled issue on every probe until
 * the clock caught up.
 */
import {
  AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import { isReadableRowTimestamp } from "../agent-sync/invocation-sync-rejection-policy.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";

/**
 * The instant through which the outbox has been scanned, or `undefined` when it
 * never has.
 *
 * An unreadable stored value is reported as `undefined` rather than parsed into a
 * guess, for the same reason the scan drops a row whose `updated_at` it cannot read:
 * the safe direction here is to treat the store as unswept and report a parked row
 * once more than necessary, never to invent an instant that silences one.
 *
 * Read on the same transaction as the scan so the marker and the rows it is compared
 * against come from ONE snapshot.
 */
export async function readInvocationSyncOutboxObservedThroughMs(
  transaction: DesktopPrismaReader
): Promise<number | undefined> {
  const marker =
    await transaction.agentComponentInvocationSyncCursor.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          externalSessionId:
            AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
        },
      },
      select: { updatedAt: true },
    });
  if (marker === null || !isReadableRowTimestamp(marker.updatedAt)) {
    return undefined;
  }
  return Date.parse(marker.updatedAt);
}

/**
 * Is `nowMs` actually newer than what the marker already records?
 *
 * The monotone guard, kept in JS against the value the scan read from its own
 * snapshot rather than expressed as an `ON CONFLICT … WHERE` predicate on the stored
 * column. That SQL form compares two STORED text timestamps byte-wise, which
 * `no-lexical-timestamp-compare` rejects for good reason (ISS-5182) — and guarding it
 * with a canonical GLOB would make a single non-canonical stored value freeze the
 * marker permanently, which is a strictly worse failure than the one it prevents: a
 * frozen marker re-reports every settled row on every probe forever.
 */
export function shouldRecordInvocationSyncOutboxObservation(
  nowMs: number,
  observedThroughMs: number | undefined
): boolean {
  return observedThroughMs === undefined || nowMs > observedThroughMs;
}

/**
 * Record `observedThroughMs` as the instant through which the outbox has been
 * scanned. Call only when {@link shouldRecordInvocationSyncOutboxObservation} says so;
 * the write itself is unconditional.
 *
 * A failure here is deliberately NOT swallowed. The counts it accompanies are already
 * correct, and a marker that fails to advance only causes the same rows to be
 * reported again next run — but the probe's own runner records a check that throws as
 * not-run, which is visible, whereas a silently skipped write would quietly make the
 * report-at-least-once guarantee unverifiable.
 */
export function recordInvocationSyncOutboxObservedThroughMs(
  prisma: DesktopPrisma,
  observedThroughMs: number
): Promise<number> {
  const observedThrough = new Date(observedThroughMs).toISOString();
  return prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_cursors
         (source_key, external_session_id, external_generation_id,
          source_sequence, updated_at)
       VALUES ($1, $2, $2, 0, $3)
       ON CONFLICT (source_key, external_session_id) DO UPDATE SET
         updated_at = excluded.updated_at`,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
      observedThrough
    )
  );
}
