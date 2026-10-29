/**
 * @file sync-lane-run-row.ts
 * @description PLN-2028 D2 (ISS-10053): how a lane-run row's four columns read
 * back onto a loaded cursor.
 *
 * WHICH row that is, is `agent-sync/sync-lane-run-key.ts`: the session lane needs
 * the same answer for its own identity, and it cannot import a `main/database`
 * module without putting the db graph on the eager boot path.
 */

import type { PersistedSyncState } from "../agent-sync/agent-session-sync-source.js";
import type { PersistedLaneRun } from "../agent-sync/sync-cursor-state-source.js";

/**
 * The lane-run half of the `sync_state` projection — split out of the cursor
 * select so a session revision key can read it from its short-key row.
 *
 * `satisfies Record<keyof PersistedLaneRun, true>` ties it to the write record: a
 * field added to {@link PersistedLaneRun} fails `tsc` here until the load asks
 * for it, instead of being written and never read back.
 */
export const SYNC_STATE_LANE_RUN_SELECT = {
  laneStalledSince: true,
  laneGaveUpAt: true,
  laneGaveUpReason: true,
  laneGaveUpSource: true,
} as const satisfies Record<keyof PersistedLaneRun, true>;

/** The lane-run fields a loaded cursor carries. */
export type LoadedLaneRunFields = Pick<
  PersistedSyncState,
  keyof PersistedLaneRun
>;

/**
 * Project a lane-run row onto a loaded cursor's fields, each OMITTED when its
 * column is NULL — so a lane that never opened a run or gave up sees no new key,
 * exactly as the stamp alone behaved before these columns existed. An absent row
 * is an empty record.
 *
 * NULL, not falsy, for the origin, reason and producer: a stored empty string is
 * a bad value, and reading it here as "no run" would hide it from the reply
 * boundary, which drops that field alone AND reports it (PLN-2028 D6). The stamp
 * keeps its ISS-9418 projection, where an empty value reads as no give-up: it
 * does not degrade alone, so surfacing one would refuse the whole cursor and cost
 * a corpus re-walk, which is not this projection's trade to make. The store's
 * writes refuse an empty value in all four (`assertWritableLaneRunColumns`), so
 * either case here is a row changed outside them.
 */
export function laneRunFieldsFromRow(
  row: PersistedLaneRun | null
): LoadedLaneRunFields {
  if (!row) {
    return {};
  }
  return {
    ...(row.laneStalledSince === null
      ? {}
      : { laneStalledSince: row.laneStalledSince }),
    ...(row.laneGaveUpAt ? { laneGaveUpAt: row.laneGaveUpAt } : {}),
    ...(row.laneGaveUpReason === null
      ? {}
      : { laneGaveUpReason: row.laneGaveUpReason }),
    ...(row.laneGaveUpSource === null
      ? {}
      : { laneGaveUpSource: row.laneGaveUpSource }),
  };
}

/** Whether a projected lane run records anything at all. */
export function hasLaneRunRecord(fields: LoadedLaneRunFields): boolean {
  return Object.keys(fields).length > 0;
}
