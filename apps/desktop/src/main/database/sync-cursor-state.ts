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
 * One table, two writers: `sync-lane-run-state.ts` writes the lane-run columns,
 * read back here via `sync-lane-run-row.ts` on the row
 * `agent-sync/sync-lane-run-key.ts` names. Every function takes the
 * `DesktopPrisma` handle explicitly rather than closing over it, matching the
 * sibling read modules (`aggregateSqliteAnalytics`, `countSqliteSessionsForFilters`, …).
 * `sync-source.ts` delegates its `AgentSessionSyncSource` methods here
 * one-for-one through `sync-cursor-state-delegates.ts`, so the source's public
 * shape is unchanged.
 *
 * Writes route through `prisma.write` so they serialize on the single-connection
 * write queue; reads use `prisma.client` (light, co-located with writes).
 */

import { AUTONOMY_FORMULA_VERSION } from "@repo/lib/session-trace/autonomy";
import { parseComponentDeadLetterRecords } from "../agent-sync/agent-component-dead-letter-persistence.js";
import {
  AGENT_SESSION_SYNC_SOURCE_KIND,
  NO_SYNC_CONTRACT_CAPABILITIES,
  type PersistedSyncState,
  parsePersistedObservedIds,
  type SyncContractCapabilities,
} from "../agent-sync/agent-session-sync-source.js";
import { emptySyncStateCursor } from "../agent-sync/sync-cursor-state-source.js";
import { buildLaneRunSourceKey } from "../agent-sync/sync-lane-run-key.js";
import { effectiveDataRevision } from "../collectors/engine/effective-data-revision.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  hasLaneRunRecord,
  laneRunFieldsFromRow,
  SYNC_STATE_LANE_RUN_SELECT,
} from "./sync-lane-run-row.js";
import {
  sqliteRependDeadLetteredForFormulaRewalk,
  sqliteRependSessionDeadLetters,
  sqliteSelectDeadLetteredSessionIds,
  sqliteSelectRedrivableSessionDeadLetters,
} from "./sync-outbox-store.js";

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
 *
 * Revision 4 (ISS-5850): `SessionSpan` now carries the absolute extent the
 * activity bins tile (`startMs`/`endMs`), where every prior build emitted only
 * the anchor-less clock offsets. Same shape of load-bearing absence as revision
 * 3: without the extent the reader cannot separate an interval the collector
 * never measured from one it observed as quiet, so it must report the extent as
 * unknown and withhold the disclosure entirely. Every session already behind the
 * keyset watermark would keep its anchor-less span permanently, so the corrected
 * value would never reach the rows that most need it — the long, sparse sessions
 * where the measured extent covers least of the rendered window.
 *
 * The span-extent rung is negotiated, not assumed (#5921 review, whitlockk). Desktop
 * and API deploy independently, so a desktop carrying this build will meet an
 * API whose `sessionSpanSchema` predates `startMs`/`endMs`. That schema is a
 * non-strict `z.object`, so it strips the pair and answers a normal ack — the
 * replay burns, the rows dequeue, and stamping an extent-capable version here
 * would record as delivered a field the peer discarded. Nothing re-pushes those
 * rows afterwards (the keyset walk is driven by `sessions.updated_at`), so they
 * would stay bounds-less forever, and the cursor would say the work was done. See
 * {@link resolveAgentSessionSyncIntegrityVersion}: what the lane stamps is the
 * highest contract the SERVER acknowledged, so the replay stays owed until a
 * server that stores the extent answers for it.
 *
 * Revision 5 (ISS-8001): cloud first-sync Branch materialization now preserves
 * full branch-ref evidence in a durable retry table when repository/default
 * authority is not available yet. Rows already synced by older builds may have
 * advanced the cursor after the cloud kept only identity/cause metadata, which
 * is intentionally insufficient for Product-visible Branch links. One replay of
 * retained SQLite sessions re-sends the original method/relation/participation
 * evidence through the idempotent cloud ingest path.
 *
 * Revision 5 must be distinct from revision 4: mainline desktops may already
 * have stamped 4 for the span-extent contract, and those cursors still need the
 * ISS-8001 replay.
 *
 * Revision 6 (ISS-7896): session `metadata` now carries `humanTurnTimestamps`,
 * derived from the FULL local `messages` array, because both sync lanes cap
 * `$.messages` at 100 and the cloud activity heatmap's HUMAN half counted only
 * that capped head (42 turns against the desktop oracle's 109 over the golden
 * corpus). The key is derived at PAYLOAD-BUILD time, and re-deriving a payload
 * does not touch `sessions.updated_at`, so without this bump every session
 * already behind the keyset watermark would never carry it — the correction
 * would reach only sessions that happen to change afterwards, and miss exactly
 * the long, high-turn sessions where the 100-cap bites hardest.
 *
 * Gated on the human-turn rung of {@link resolveAgentSessionSyncIntegrityVersion}
 * for the same reason revision 4 is gated on the span extent, and the failure
 * mode here is worse than a dropped field. An API that predates this contract
 * does not reject the key: its persist boundary caps the unrecognized array at
 * the generic `MAX_METADATA_ARRAY_ITEMS` (100) and answers a normal ack. The
 * cloud reader treats a present array as AUTHORITATIVE, so once that API
 * deploys, the truncated copy WINS over the `$.messages` fallback and the
 * session reports 100 human turns forever. Withholding the stamp keeps the
 * replay owed until an API that stores the whole array answers for it, so a
 * release that ships Desktop before the API self-corrects rather than silently
 * under-reporting.
 *
 * Revision 7 (ISS-9864): session `metadata` now also carries
 * `agentTurnTimestamps`, derived from the FULL local `messages` array for a
 * session that synced no token events — the population the cloud heatmap's
 * legacy Agent arm serves, which read only the capped `$.messages` head.
 * Same mechanism, same reasons, same gating as revision 6: the key is derived
 * at payload-build time, nothing re-pushes an unchanged session, and an API
 * that predates the contract stores a capped copy the reader would take as
 * authoritative. The stamp is gated on the agent-turn rung of
 * {@link resolveAgentSessionSyncIntegrityVersion}.
 *
 * Revision 8 (ISS-12552): token events carry their owning agent and sessions
 * carry operation evidence, both only to a server that advertised
 * `agentSessionSyncTokenEventOwner`. An older API is sent neither owners (they
 * are stripped, since it rejects an owner it did not store) nor evidence it
 * keeps (its non-strict schema drops the key), and acks normally; nothing
 * re-pushes an unchanged session, so both would stay missing after the API
 * upgrades. Same mechanism and gating as revisions 6 and 7, on the owner rung.
 */
export const AGENT_SESSION_SYNC_INTEGRITY_VERSION = 8 as const;

/**
 * ISS-12552: the revision a lane may stamp when the connected server stores
 * both turn arrays but has NOT advertised `agentSessionSyncTokenEventOwner`.
 * Revision 7's contract is fully satisfied by such a server, and the gap is
 * what makes {@link sessionSyncIntegrityCursorIsStale} fire exactly once on
 * the first connection to an owner-capable server.
 */
export const AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER =
  7 as const;

/**
 * ISS-9864: the revision a lane may stamp when the connected server stores the
 * human-turn array but has NOT advertised `agentSessionSyncAgentTurnTimestamps`.
 *
 * Revision 6's contract is fully satisfied by such a server, so this is the
 * honest stamp rather than a degraded one — and it is what makes
 * {@link sessionSyncIntegrityCursorIsStale} fire exactly once on the first
 * connection to an agent-turn-capable server.
 */
export const AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS =
  6 as const;

/**
 * ISS-7896: the revision a lane may stamp when the connected server stores the
 * span extent but has NOT advertised `agentSessionSyncHumanTurnTimestamps`.
 *
 * Revision 5's contract is fully satisfied by such a server, so this is the
 * honest stamp rather than a degraded one — and it is what makes
 * {@link sessionSyncIntegrityCursorIsStale} fire exactly once on the first
 * connection to a human-turn-capable server.
 */
export const AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS =
  5 as const;

/**
 * ISS-5850: the revision a lane may stamp when the connected server has NOT
 * advertised `agentSessionSyncSpanExtent`.
 *
 * Revision 3's contract (ISS-5999's per-bin bounds) is fully satisfied by such a
 * server, so this is not a degraded stamp — it is the honest one, and it is what
 * makes {@link sessionSyncIntegrityCursorIsStale} fire exactly once on the first
 * connection to a capable server.
 */
export const AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT =
  3 as const;

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
  sourceKey: string,
  contract: SyncContractCapabilities = NO_SYNC_CONTRACT_CAPABILITIES
): Promise<PersistedSyncState | null> {
  const { row, laneRun } = await readCursorAndLaneRunRows(prisma, sourceKey);
  if (!row) {
    // PLN-2028: a lane run with no cursor row yet (a first-launch give-up, or a
    // revision key's run on its short-key row) loads as an empty cursor.
    return hasLaneRunRecord(laneRun)
      ? { ...emptySyncStateCursor(), ...laneRun }
      : null;
  }
  const deadLetteredIds = parsePersistedObservedIds(row.deadLetteredIds);
  const requiresFullRewalk =
    autonomyFormulaCursorIsStale(sourceKey, row.autonomyFormulaVersion) ||
    sessionSyncIntegrityCursorIsStale(
      sourceKey,
      row.syncIntegrityVersion,
      contract
    );
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
      // An empty `deadLetteredIds` too: those ids are now pending on disk, so
      // they are no longer set aside as dead letters. ISS-8593: and with no ids
      // set aside there is no bookkeeping to join to, so the optional field is
      // OMITTED rather than answered as an empty array.
      ...emptySyncStateCursor(),
      // ISS-9418 / PLN-2028: the lane run — the give-up and the run it ended —
      // SURVIVES a full re-walk. A formula or contract bump is a LOCAL change; it
      // says nothing about whether the cloud this lane gave up on is reachable
      // again. Dropping it here would hand a lane that is still inside a 24h
      // outage an unbounded retry back, which is the exact shape invariant 5
      // forbids. The re-arm door (an event, or the widening window) clears it.
      ...laneRun,
    };
  }
  // ISS-8593: the component lane's per-id bookkeeping (migration 0080).
  // Absent/legacy/corrupt → `[]`, which costs the restored backoff position and
  // never a row: the ids themselves still load below.
  const {
    records: deadLetterAttempts,
    droppedCount: deadLetterAttemptsDropped,
  } = parseComponentDeadLetterRecords(row.deadLetterAttempts);
  return {
    observedTopUpdatedAt: row.observedTopUpdatedAt ?? null,
    observedIdsAtTopUpdatedAt: parsePersistedObservedIds(
      row.observedIdsAtTopUpdatedAt
    ),
    // Nullable JSON column (migration 0024): missing/null → `[]` so a cursor
    // written before this column existed loads with no dead-letters set aside.
    // ISS-8271 (PLN-1839 Step 3): minus the rows the targeted boot redrive just
    // re-pended — a re-driven row must not be re-seeded as a set-aside
    // dead-letter, or the `pending` row it now owns would be skipped by every
    // feed path (`isTracked`) and stranded again.
    deadLetteredIds: await redriveSessionDeadLettersOnLoad(
      prisma,
      sourceKey,
      deadLetteredIds
    ),
    // OMITTED when there is nothing to say, never answered as an empty array.
    // That is the repo's rule for an absent optional field crossing a boundary,
    // and it is what keeps a SESSION cursor's loaded shape byte-identical to
    // what it was before this column existed — that lane neither sets nor reads
    // it, so it must not start seeing a new key.
    ...(deadLetterAttempts.length > 0 ? { deadLetterAttempts } : {}),
    // ISS-8593 (marisolashgrove review): reported SEPARATELY from the records, and
    // it must be — the case this exists for is a row whose entries were ALL
    // refused, where `deadLetterAttempts` is empty and therefore omitted while
    // the ids it should have described still load below. Omitted at zero, like
    // every other absent optional field crossing this boundary.
    ...(deadLetterAttemptsDropped > 0 ? { deadLetterAttemptsDropped } : {}),
    // ISS-9418 / PLN-2028: the durable lane run, read from the lane-run row. Each
    // field is OMITTED when its column is NULL (`laneRunFieldsFromRow`), so a lane
    // that never gives up never sees a new key — the rule the two above follow.
    ...laneRun,
  };
}

/**
 * ISS-9418: the `sync_state` columns that identify WHICH contract a row's cursor
 * was walked under, stamped identically by every writer of this table.
 *
 * Extracted so the lane-run writes (`sync-lane-run-state.ts`, which receive them
 * from the delegate) can create a row without restating them. Restating them is the SSOT-drift-by-copy failure this repo has shipped
 * before, and here it would be load-bearing: a row created with a NULL
 * `autonomyFormulaVersion` reads as "predates migration 0040" and forces a
 * corpus re-walk that nothing asked for.
 *
 * Stamping them on a row whose watermark is NULL claims nothing false: a NULL
 * watermark IS the full re-walk, so the version stamps suppress no work that was
 * owed.
 */
export function syncStateContractStamps(
  contract: SyncContractCapabilities = NO_SYNC_CONTRACT_CAPABILITIES
) {
  return {
    dataRevision: effectiveDataRevision(),
    autonomyFormulaVersion: AUTONOMY_FORMULA_VERSION,
    syncIntegrityVersion: resolveAgentSessionSyncIntegrityVersion(contract),
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
  state: PersistedSyncState,
  contract: SyncContractCapabilities = NO_SYNC_CONTRACT_CAPABILITIES
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
        // ISS-8593: an absent value is passed through as `undefined` rather than
        // normalized to `[]`, so a lane that does not manage this column (the
        // session lane) writes SQL NULL here and reads back no bookkeeping at all
        // — byte-identical to a pre-0080 row. It is not a "leave it untouched":
        // in `create` there is nothing to leave, and `undefined` writes NULL
        // (marisolashgrove review). Nor is it protecting a sibling: the two lanes
        // key `sync_state` under different `sourceKey` prefixes
        // (`buildAgentComponentSyncSourceKey` vs the session one), so they never
        // share a row and there is no sibling bookkeeping to clobber.
        deadLetterAttempts: state.deadLetterAttempts,
        // FEA-3781: stamp the formula this lane is uploading under, so the
        // one-time re-walk in `loadSyncState` fires once and then stops.
        // Written for every lane; only the session lane reads it back.
        ...syncStateContractStamps(contract),
        updatedAt,
      },
      // ISS-9418 / PLN-2028: the four lane-run columns are deliberately absent
      // from BOTH branches. In `create` an omitted column writes SQL NULL, which
      // is correct for a lane persisting its first cursor. In `update` an omitted
      // column is left untouched, which is what keeps the lane run owned by
      // `sync-lane-run-state.ts` alone — a cursor advance and a give-up are
      // different events and must not clobber each other.
      update: {
        observedTopUpdatedAt: state.observedTopUpdatedAt,
        observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
        deadLetteredIds: state.deadLetteredIds,
        deadLetterAttempts: state.deadLetterAttempts,
        ...syncStateContractStamps(contract),
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
 *
 * ISS-5850: compared against the revision the CONNECTED SERVER can honour
 * ({@link resolveAgentSessionSyncIntegrityVersion}), not against this build's
 * maximum, and `<` rather than `!==`. Both halves are load-bearing:
 *
 *  - against the SERVER's revision, because a cursor stamped 3 by a desktop that
 *    only ever met a pre-extent API is not "caught up"; the moment a capable
 *    server answers, `3 < current` fires the replay that carries the extent up.
 *  - `<`, because the capability can go DOWN mid-rollout (a mixed API fleet, a
 *    rollback), and `!==` would then read a cursor stamped at the HIGHER revision
 *    as stale and re-walk the entire local corpus on every flip. A stamp records
 *    delivery that already happened, and an older peer appearing does not undo
 *    it, so `stored > expected` is genuinely not stale. A NULL still is — that is
 *    a cursor predating migration 0049, which has delivered nothing under any of
 *    these contracts.
 */
export function sessionSyncIntegrityCursorIsStale(
  sourceKey: string,
  storedVersion: number | null,
  contract: SyncContractCapabilities = NO_SYNC_CONTRACT_CAPABILITIES
): boolean {
  if (!sourceKey.startsWith(`${AGENT_SESSION_SYNC_SOURCE_KIND}:`)) {
    return false;
  }
  if (storedVersion === null) {
    return true;
  }
  return storedVersion < resolveAgentSessionSyncIntegrityVersion(contract);
}

/** The CURSOR columns {@link sqliteLoadSyncState} consumes (lane run: `SYNC_STATE_LANE_RUN_SELECT`). */
type SyncStateCursorColumn =
  | "observedTopUpdatedAt"
  | "observedIdsAtTopUpdatedAt"
  | "deadLetteredIds"
  | "deadLetterAttempts"
  | "autonomyFormulaVersion"
  | "syncIntegrityVersion";

/**
 * ISS-6326: `sourceKey` is the query predicate (already known to the caller),
 * `dataRevision` has been read by nothing since FEA-3659 made the cursor survive
 * a revision bump, and `updatedAt` is write-side bookkeeping — so the load never
 * asks for them.
 *
 * Dropping a column that IS consumed fails `tsc` at the reads below, because the
 * narrowed payload no longer carries the property. Re-widening does not — that
 * is the direction the `satisfies` covers: a key added back here is an excess
 * property and fails to compile.
 *
 * Both version stamps are load-bearing in a way `tsc` cannot see once a value
 * reaches the comparison: a narrowed-away column arrives as `undefined`, reads
 * stale, and makes every boot clear the watermark and re-walk the whole local
 * corpus.
 */
const SYNC_STATE_CURSOR_SELECT = {
  observedTopUpdatedAt: true,
  observedIdsAtTopUpdatedAt: true,
  deadLetteredIds: true,
  deadLetterAttempts: true,
  autonomyFormulaVersion: true,
  syncIntegrityVersion: true,
} as const satisfies Record<SyncStateCursorColumn, true>;

/**
 * ISS-5850: which payload contract this lane may claim to have DELIVERED under,
 * given what the connected server said it can store.
 *
 * The single owner of the capability→revision mapping, so the read side
 * ({@link sessionSyncIntegrityCursorIsStale}) and the write side
 * ({@link sqliteAdvanceSyncState}) cannot drift into disagreeing about what a
 * stored stamp means — a disagreement whose failure mode is not a missed replay
 * but a full corpus re-walk on EVERY boot.
 *
 * `false` is the default everywhere it is threaded, and deliberately so: a
 * caller that cannot prove the server stores the extent must not claim it did.
 */
export function resolveAgentSessionSyncIntegrityVersion(
  contract: SyncContractCapabilities
): number {
  if (!contract.spanExtent) {
    return AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_SPAN_EXTENT;
  }
  if (!contract.humanTurnTimestamps) {
    return AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_HUMAN_TURN_TIMESTAMPS;
  }
  if (!contract.agentTurnTimestamps) {
    return AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_AGENT_TURN_TIMESTAMPS;
  }
  return contract.tokenEventOwner
    ? AGENT_SESSION_SYNC_INTEGRITY_VERSION
    : AGENT_SESSION_SYNC_INTEGRITY_VERSION_WITHOUT_TOKEN_EVENT_OWNER;
}

/**
 * ISS-8271 (PLN-1839 Step 3): the targeted per-boot session dead-letter redrive
 * — parity with the invocation lane's `redriveValidationFailedInvocationParts`.
 * Rides the cursor load for the same reason the FEA-3781 formula-rewalk flip
 * does: the load is the lane's once-per-hydration prepare, and the flip must
 * land on disk BEFORE the service seeds its in-memory dead-letter set and reads
 * the pending outbox, so the re-driven rows are fed this very boot.
 *
 * Which rows qualify — `ack_omitted` only while its durable
 * `ack_omitted_cycle_count` is under `MAX_ACK_OMITTED_DEAD_LETTERS`,
 * `validation_failed` only once the session row carries a real
 * `data_revision` — is
 * {@link sqliteSelectRedrivableSessionDeadLetters}'s contract.
 *
 * Returns the cursor dead-letter list MINUS the re-driven ids, and writes that
 * subtraction durably. The durable half is load-bearing: the cursor's
 * `deadLetteredIds` is only rewritten on the next `advanceSyncState`, so
 * without it a crash before the next persist would leave the stale list to
 * re-seed the id as set-aside on the following boot — shadowing the now-pending
 * outbox row forever (`isTracked` blocks every feed path). Write ORDER is the
 * crash-safety: the cursor subtraction lands before the outbox flip, so a crash
 * between the two leaves the row still `dead_lettered` with its `last_error`
 * intact and the next boot's redrive simply matches it again — the reverse
 * order would leave a pending row shadowed by a stale seed, the exact strand
 * this pass exists to remove.
 *
 * Scoped to the agent-session lane by `sourceKey` prefix (the component lane
 * shares `sync_state` but owns no `agent_session_sync_outbox` rows — the guard
 * makes the skip explicit rather than relying on an empty read).
 */
async function redriveSessionDeadLettersOnLoad(
  prisma: DesktopPrisma,
  sourceKey: string,
  cursorDeadLetteredIds: string[]
): Promise<string[]> {
  if (!sourceKey.startsWith(`${AGENT_SESSION_SYNC_SOURCE_KIND}:`)) {
    return cursorDeadLetteredIds;
  }
  const redrivableIds = await sqliteSelectRedrivableSessionDeadLetters(
    prisma,
    sourceKey
  );
  const redrivenSet = new Set(redrivableIds);
  // ISS-11427: also drop an id whose outbox row is no longer `dead_lettered`.
  // A verified ack deletes the row and clears the in-memory marker, but the
  // cursor list is rewritten only when the watermark next advances, so without
  // this a delivered session is re-seeded as set-aside on the next boot and its
  // row reports a dead letter it no longer is.
  const stillDeadLettered = await sqliteSelectDeadLetteredSessionIds(
    prisma,
    sourceKey,
    cursorDeadLetteredIds
  );
  const remaining = cursorDeadLetteredIds.filter(
    (id) => !redrivenSet.has(id) && stillDeadLettered.has(id)
  );
  if (remaining.length !== cursorDeadLetteredIds.length) {
    const updatedAt = new Date().toISOString();
    await prisma.write((client) =>
      client.syncState.update({
        where: { sourceKey },
        data: { deadLetteredIds: remaining, updatedAt },
      })
    );
  }
  if (redrivableIds.length > 0) {
    await sqliteRependSessionDeadLetters(prisma, sourceKey, redrivableIds);
  }
  return remaining;
}

/** The contract stamps every writer of `sync_state` puts on a row it creates. */
export type SyncStateContractStamps = ReturnType<
  typeof syncStateContractStamps
>;

/**
 * PLN-2028 D2: cursor columns from `sourceKey`'s row, lane-run columns from the
 * row `buildLaneRunSourceKey` names — one query when that is the same row, two
 * parallel reads when it is not (once per hydrated identity, not per tick).
 */
async function readCursorAndLaneRunRows(
  prisma: DesktopPrisma,
  sourceKey: string
) {
  const laneRunKey = buildLaneRunSourceKey(sourceKey);
  if (laneRunKey === sourceKey) {
    const row = await prisma.client.syncState.findUnique({
      where: { sourceKey },
      select: { ...SYNC_STATE_CURSOR_SELECT, ...SYNC_STATE_LANE_RUN_SELECT },
    });
    return { row, laneRun: laneRunFieldsFromRow(row) };
  }
  const [row, laneRunRow] = await Promise.all([
    prisma.client.syncState.findUnique({
      where: { sourceKey },
      select: SYNC_STATE_CURSOR_SELECT,
    }),
    prisma.client.syncState.findUnique({
      where: { sourceKey: laneRunKey },
      select: SYNC_STATE_LANE_RUN_SELECT,
    }),
  ]);
  return { row, laneRun: laneRunFieldsFromRow(laneRunRow) };
}
