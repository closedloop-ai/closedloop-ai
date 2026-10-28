/**
 * @file sync-cursor-state-source.ts
 * @description The durable `sync_state` slice of `AgentSessionSyncSource`: the
 * cursor load and advance, the lane give-up stamp, and (PLN-2028) the lane run
 * that stamp belongs to. The port-side twin of
 * `database/sync-cursor-state-delegates.ts`, which implements exactly these ops.
 *
 * Split out of `agent-session-sync-source.ts` (ISS-10053) so the lane-run write
 * could be added without pushing that port past the 1,000-line ceiling. The three
 * pre-existing ops moved verbatim, and all four are still `AgentSessionSyncSource`
 * members through the intersection there — so the db-host op registry's
 * `keyof AgentSessionSyncSource` guard still enumerates every one of them.
 *
 * It takes only TYPES from that port, so it is never a runtime import back into
 * the module that intersects it. The lane-run row key these ops resolve is
 * `buildLaneRunSourceKey` (`sync-lane-run-key.ts`).
 */

import { z } from "zod";
import type {
  PersistedSyncState,
  SyncContractCapabilities,
} from "./agent-session-sync-source.js";

/**
 * One lane's durable lane RUN, as a {@link SyncCursorStateSource.recordLaneRun}
 * write carries it: when the current environmental run opened, and when, why and
 * by which producer the lane gave up on it. `null` clears a column, so every write
 * names all four — a record, not a patch.
 *
 * Reason and source are opaque to the store: any non-empty string persists, and
 * interpreting it is the adopting lane's job, so a newer build's value cannot
 * fail the write. What each column accepts is {@link LANE_RUN_COLUMN_SCHEMAS}.
 */
export type PersistedLaneRun = {
  laneStalledSince: string | null;
  laneGaveUpAt: string | null;
  laneGaveUpReason: string | null;
  laneGaveUpSource: string | null;
};

export type SyncCursorStateSource = {
  /**
   * FEA-1962: load the persisted durable cursor for `sourceKey`, or `null` when
   * none exists (fresh sqlite / first run after upgrade → full backfill as today).
   * Optional so fake test sources and pre-FEA-1962 sources behave like today.
   */
  loadSyncState?(
    sourceKey: string,
    contract?: SyncContractCapabilities
  ): PersistedSyncState | null | Promise<PersistedSyncState | null>;
  /**
   * FEA-1962: persist the durable cursor for `sourceKey`. Called ONLY after an
   * accepted ack for a contiguous prefix of rows — never for discovery-only
   * candidates or failed/retryable/dead-lettered rows.
   *
   * `contract` is what the connected server proved it can STORE
   * ({@link SyncContractCapabilities}), and it selects which payload-contract
   * revision the stamp records — see
   * `resolveAgentSessionSyncIntegrityVersion`. Both this and the load above
   * take it because the two sides compare the same value; passing it to one
   * and not the other makes every boot re-walk the corpus. Optional so
   * pre-ISS-5850 and fake sources behave as before (the pre-extent revision).
   */
  advanceSyncState?(
    sourceKey: string,
    state: PersistedSyncState,
    contract?: SyncContractCapabilities
  ): void | Promise<void>;
  /**
   * ISS-9418: stamp (or clear, with `null`) this lane's durable give-up for
   * `sourceKey`.
   *
   * Separate from {@link advanceSyncState} on purpose: that write means "a
   * contiguous prefix was acked", and a give-up means the opposite — nothing
   * was accepted and the cursor has not moved. It touches only the stamp, so
   * a give-up can never rewrite a watermark or a dead-letter set.
   *
   * Optional so pre-ISS-9418 and fake sources behave as before: a lane whose
   * source does not implement it keeps its in-process ceiling and simply
   * loses the stamp across a relaunch, which is the pre-0082 behaviour.
   *
   * PLN-2028: now the stamp-only COMPATIBILITY ALIAS of {@link recordLaneRun}.
   * It writes to the same lane-run row (`buildLaneRunSourceKey`) and still
   * touches no other column, so a caller that predates the lane run keeps
   * working across an upgrade. Removing it needs explicit human approval.
   */
  recordLaneGiveUp?(
    sourceKey: string,
    gaveUpAt: string | null,
    contract?: SyncContractCapabilities
  ): void | Promise<void>;
  /**
   * PLN-2028 (ISS-10053): write this lane's whole durable lane run — origin,
   * give-up instant, reason and producer — in one write, to the row
   * `buildLaneRunSourceKey` names for `sourceKey`.
   *
   * Like {@link recordLaneGiveUp} it never touches a watermark or a dead-letter
   * set, and {@link advanceSyncState} never touches it. Optional for the same
   * reason that op is: a source without it keeps an in-process run.
   */
  recordLaneRun?(
    sourceKey: string,
    run: PersistedLaneRun,
    contract?: SyncContractCapabilities
  ): void | Promise<void>;
};

/**
 * The cursor a `sync_state` row with no watermark loads as: the first-run /
 * full-backfill position. Its one spelling, so a required field added to
 * {@link PersistedSyncState} fails `tsc` here instead of being missed at one of
 * the store's empty-cursor sites. A function rather than a constant because the
 * arrays are mutable, and no two cursors may share one.
 */
export function emptySyncStateCursor() {
  return {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    deadLetteredIds: [],
  } satisfies PersistedSyncState;
}

/**
 * PLN-2028: what a non-null value in each lane-run column must be, owned once
 * for both sides of the store. The write refuses a value outside it
 * (`assertWritableLaneRunColumns`, `database/sync-lane-run-state.ts`) and the
 * reply boundary drops or refuses one read back
 * (`persisted-sync-state-reply-boundary.ts`), so the store cannot persist a value
 * its own load would reject.
 *
 * The origin and the stamp are canonical ISO instants because each is parsed
 * back into a clock. Reason and producer are any non-empty string, never an enum:
 * the adopting lane narrows them, and a newer build's value must reach it as
 * unknown rather than fail here.
 */
export const LANE_RUN_COLUMN_SCHEMAS = {
  laneStalledSince: z.iso.datetime(),
  laneGaveUpAt: z.iso.datetime(),
  laneGaveUpReason: z.string().min(1),
  laneGaveUpSource: z.string().min(1),
} satisfies Record<keyof PersistedLaneRun, z.ZodTypeAny>;
