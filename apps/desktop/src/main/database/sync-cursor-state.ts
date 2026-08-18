/**
 * @file sync-cursor-state.ts
 * @description The durable keyset CURSOR (`sync_state`) for the desktop→cloud
 * agent-session sync lane: how far this lane has walked, and the revision stamps
 * that decide whether that watermark is still trustworthy. Sibling of
 * `sync-outbox-store.ts` (what still owes delivery); together they are the
 * delivery-state half that FEA-3781 split out of `sync-source.ts`, which is
 * about BUILDING sync payloads — hydrating sessions, assembling the wire shape,
 * bounding it.
 *
 * One table, one module. Every function takes the `DesktopPrisma` handle
 * explicitly rather than closing over it, matching the sibling read modules
 * (`aggregateSqliteAnalytics`, `countSqliteSessionsForFilters`, …).
 * `sync-source.ts` delegates its `AgentSessionSyncSource` methods here
 * one-for-one, so the source's public shape is unchanged.
 *
 * Writes route through `prisma.write` so they serialize on the single-connection
 * write queue; reads use `prisma.client` (light, co-located with writes).
 */

import { AUTONOMY_FORMULA_VERSION } from "@repo/lib/session-trace/autonomy";
import {
  AGENT_SESSION_SYNC_SOURCE_KIND,
  type PersistedSyncState,
  parsePersistedObservedIds,
} from "../agent-sync/agent-session-sync-source.js";
import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { sqliteRependDeadLetteredForFormulaRewalk } from "./sync-outbox-store.js";

/**
 * ISS-5086: bump when a prior desktop build could have advanced the durable
 * session cursor past locally-present rows, OR (ISS-4569) when a payload field's
 * meaning changed such that already-synced rows hold a value this build would now
 * compute differently. A stale or absent stamp clears the watermark once, causing
 * the normal crash-safe full re-walk to reconcile every local session through the
 * idempotent cloud upsert lane.
 *
 * Revision 2 (ISS-4569): `activeAgent`/`waitingUser` now emit `"0s"` for a
 * MEASURED zero, where every prior build sent `null`. Nothing else in this PR
 * schedules a reimport, so without the bump the corrected value would only ever
 * reach rows that happen to change again — every unchanged terminal session
 * already synced behind the watermark would keep its `null` in the cloud forever.
 *
 * Revision 3 (ISS-5999): `ActivityBucket` now carries the producer's own bin
 * bounds (`binStartMs`/`binEndMs`), where every prior build emitted priced bins
 * with no clock on them. The reader refuses to project a bounds-less strip onto
 * a wall-clock axis rather than fabricate one, so the field's absence is now
 * load-bearing. Selection is a keyset walk over `sessions.updated_at`, so every
 * session already behind the watermark would keep its bounds-less buckets
 * permanently — rendering as an ordinal strip with no scale toggle and no
 * scrubber — because nothing else re-pushes those rows (FEA-3659 made the
 * durable cursor survive `DATA_REVISION` bumps, and ISS-5135 retired the heal
 * that used to cover this).
 */
export const AGENT_SESSION_SYNC_INTEGRITY_VERSION = 3 as const;

/**
 * FEA-1962: load the durable cursor for `sourceKey` via the typed
 * `SyncState` delegate. The `Json` ids column comes back pre-parsed; a
 * malformed value degrades to `[]` (full
 * re-discovery) rather than throwing. Absent row → `null` (full backfill).
 *
 * FEA-3659: a cursor stamped under a DIFFERENT `DATA_REVISION` is NO LONGER
 * treated as absent. Previously a bump discarded the cursor and forced a full
 * corpus re-walk that re-uploaded all ~3600 sessions — because the boot rebuild
 * bumped `updated_at` on every rebuilt row regardless of whether its derived
 * payload changed. That root cause is now fixed (write-core's split change-gate:
 * a byte-identical re-derivation stamps only `data_revision`, leaving
 * `updated_at` untouched), so the durable watermark can safely survive a bump:
 * the incremental `updated_at >= watermark` scan then naturally picks up only
 * the genuinely-changed rows, and the rebuild also explicitly enqueues that
 * changed set into the outbox as a belt-and-suspenders hand-off. `advanceSyncState`
 * re-stamps the current DATA_REVISION on the next persist. (A legacy cursor
 * persisted before this change with a stale revision now resumes cleanly instead
 * of triggering a spurious full walk.)
 *
 * FEA-3781: NOT purely a read. When this lane's cursor was stamped under a
 * superseded autonomy formula, this also performs a one-time durable write —
 * re-pending the lane's dead-lettered outbox rows (see the branch below). It is
 * idempotent and self-limiting: the version stamp advances only on
 * `advanceSyncState`, so the write happens at most once per formula bump.
 */
export async function sqliteLoadSyncState(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<PersistedSyncState | null> {
  const row = await prisma.client.syncState.findUnique({
    where: { sourceKey },
  });
  if (!row) {
    return null;
  }
  const deadLetteredIds = parsePersistedObservedIds(row.deadLetteredIds);
  const requiresFullRewalk =
    autonomyFormulaCursorIsStale(sourceKey, row.autonomyFormulaVersion) ||
    sessionSyncIntegrityCursorIsStale(sourceKey, row.syncIntegrityVersion);
  if (requiresFullRewalk) {
    // FEA-3781 / ISS-5086: a payload-wide semantic change or a prior cursor
    // integrity defect requires one full parity walk. Clearing the watermark
    // (NOT the whole row) makes the next tick take the first-run path —
    // `initializeBackfillQueueIfNeeded` re-walks the corpus, durably seeds the
    // outbox, and re-persists a cursor stamped with both current versions, so
    // this costs ONE idempotent re-upload and never repeats.
    //
    // A full re-walk is the sanctioned mechanism for "every row's payload
    // changed" — it is the same path a first run and an account switch take.
    // The bulk-enqueue mechanism is for a KNOWN CHANGED SUBSET (the
    // DATA_REVISION rebuild); here the subset is the whole corpus, and
    // materializing every session id into the outbox in one boot write is
    // exactly the saturation this avoids.
    //
    // Dead letters must be DURABLY re-pended, not just re-walked in memory.
    // With the watermark cleared the service never seeds the recorded
    // dead-letters (that seeding sits behind `if (persisted.observedTopUpdatedAt)`),
    // and `loadPendingOutboxIds` excludes `dead_lettered` rows — so a crash
    // after the fresh cursor is stamped but before such a row is sent would
    // leave the next boot with no pending outbox row, no cursor dead-letter, and
    // a watermark already past it. That session's cloud score would sit on the
    // old formula forever. Flipping the rows on disk first makes them
    // recoverable through the normal pending path at every point in the window.
    //
    // Retrying an abandoned row is the correct call here — a full parity re-walk
    // is exactly the kind of event that earns one more attempt — and it is bounded:
    // a row that fails again simply re-dead-letters. Idempotent, because the
    // version stamp only advances on `advanceSyncState`; a crash before that
    // re-detects staleness next boot and matches zero rows the second time.
    await sqliteRependDeadLetteredForFormulaRewalk(prisma, sourceKey);
    return {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      // Now pending on disk, so they are no longer set aside as dead letters.
      deadLetteredIds: [],
    };
  }
  return {
    observedTopUpdatedAt: row.observedTopUpdatedAt ?? null,
    observedIdsAtTopUpdatedAt: parsePersistedObservedIds(
      row.observedIdsAtTopUpdatedAt
    ),
    // Nullable JSON column (migration 0024): missing/null → `[]` so a cursor
    // written before this column existed loads with no dead-letters set aside.
    deadLetteredIds,
  };
}

/**
 * FEA-1962: upsert the durable cursor via the typed `SyncState` delegate,
 * stamping the current DATA_REVISION and (FEA-3781) the autonomy formula
 * version. Routed through `prisma.write` so the write serializes on the same
 * single-connection queue as every other SQLite write; the `Json` ids column
 * takes the JS array directly — the delegate serializes it.
 */
export async function sqliteAdvanceSyncState(
  prisma: DesktopPrisma,
  sourceKey: string,
  state: PersistedSyncState
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await prisma.write((client) =>
    client.syncState.upsert({
      where: { sourceKey },
      create: {
        sourceKey,
        observedTopUpdatedAt: state.observedTopUpdatedAt,
        observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
        deadLetteredIds: state.deadLetteredIds,
        dataRevision: DATA_REVISION,
        // FEA-3781: stamp the formula this lane is uploading under, so the
        // one-time re-walk in `loadSyncState` fires once and then stops.
        // Written for every lane; only the session lane reads it back.
        autonomyFormulaVersion: AUTONOMY_FORMULA_VERSION,
        syncIntegrityVersion: AGENT_SESSION_SYNC_INTEGRITY_VERSION,
        updatedAt,
      },
      update: {
        observedTopUpdatedAt: state.observedTopUpdatedAt,
        observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
        deadLetteredIds: state.deadLetteredIds,
        dataRevision: DATA_REVISION,
        autonomyFormulaVersion: AUTONOMY_FORMULA_VERSION,
        syncIntegrityVersion: AGENT_SESSION_SYNC_INTEGRITY_VERSION,
        updatedAt,
      },
      select: { sourceKey: true },
    })
  );
}

/**
 * FEA-3781: whether a persisted cursor was written under a superseded autonomy
 * formula and must therefore re-walk the corpus once.
 *
 * Scoped to the AGENT-SESSION lane on purpose. `sync_state` is shared by two
 * lanes under different source-kind prefixes — session metadata and component
 * inventory — and only the session lane carries an autonomy score, so resetting
 * the other's watermark would re-upload unrelated data for no benefit. (The
 * component-INVOCATION lane is a third sync lane but keeps its cursor in its own
 * `agent_component_invocation_sync_cursors` table and never touches this one.)
 * The write path stamps the column for every lane that uses this table (one
 * upsert shape, nothing to keep in sync); only this read discriminates.
 *
 * `null` means the cursor predates migration 0040, i.e. it was written before
 * FEA-3781 — stale by definition, which is exactly the population that needs the
 * re-walk.
 */
export function autonomyFormulaCursorIsStale(
  sourceKey: string,
  storedVersion: number | null
): boolean {
  if (!sourceKey.startsWith(`${AGENT_SESSION_SYNC_SOURCE_KIND}:`)) {
    return false;
  }
  return storedVersion !== AUTONOMY_FORMULA_VERSION;
}

/**
 * ISS-5086: only the agent-session lane used `sessions.updated_at` as the
 * vulnerable import cursor. A NULL value means migration 0049 added the column
 * to a pre-fix cursor; any SUPERSEDED value (ISS-4569: a cursor stamped at
 * revision 1) means the lane last uploaded under an older payload contract.
 * Either way, returning stale triggers one full parity re-walk. The next accepted
 * cursor persist stamps the current version, making the repair self-limiting
 * across restarts.
 */
export function sessionSyncIntegrityCursorIsStale(
  sourceKey: string,
  storedVersion: number | null
): boolean {
  if (!sourceKey.startsWith(`${AGENT_SESSION_SYNC_SOURCE_KIND}:`)) {
    return false;
  }
  return storedVersion !== AGENT_SESSION_SYNC_INTEGRITY_VERSION;
}
