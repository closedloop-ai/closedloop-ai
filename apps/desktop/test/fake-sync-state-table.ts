/**
 * @file fake-sync-state-table.ts
 * @description The in-memory stand-in for the sqlite `sync_state` table behind
 * `FakeSyncSource`: the durable cursor and (ISS-9418, PLN-2028) the lane run.
 * Split out of `fake-sync-source.ts` when the lane run made this table key-aware.
 *
 * It mirrors the real store's ROW model rather than its call log, because what a
 * lane depends on is where a value comes BACK from: cursor fields live on
 * `sourceKey`'s row, and the four lane-run fields on the row
 * `buildLaneRunSourceKey` names (PLN-2028 D2). A fake that kept a run under
 * whatever key wrote it would make a session capability flip look harmless in
 * every suite built on it — the exact split the real store exists to prevent.
 * `sync-lane-run-state.test.ts` drives this table and the real store through one
 * sequence and holds their answers equal.
 */
import type { PersistedSyncState } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  emptySyncStateCursor,
  type PersistedLaneRun,
} from "../src/main/agent-sync/sync-cursor-state-source.js";
import { buildLaneRunSourceKey } from "../src/main/agent-sync/sync-lane-run-key.js";
import {
  hasLaneRunRecord,
  laneRunFieldsFromRow,
} from "../src/main/database/sync-lane-run-row.js";
import { assertWritableLaneRunColumns } from "../src/main/database/sync-lane-run-state.js";

export class FakeSyncStateTable {
  private readonly rows = new Map<string, PersistedSyncState>();
  readonly advanceCalls: Array<{
    sourceKey: string;
    state: PersistedSyncState;
  }> = [];
  /**
   * PLN-2028 M4: the WHOLE-RECORD writes. The stamp-only alias is deliberately
   * NOT logged beside them — the two write different column sets, and a suite
   * that merged them could not tell a lane that recorded its run origin from one
   * that wrote a bare instant, which is the difference M4 exists to make.
   */
  readonly laneRunWrites: Array<{
    sourceKey: string;
    run: PersistedLaneRun;
  }> = [];

  /**
   * Seed what a PRIOR process's writes would have left: the cursor on
   * `sourceKey`'s row, and any lane-run field on the lane-run row. Recorded as
   * neither write, because nothing in this run issued them.
   */
  seed(sourceKey: string, state: PersistedSyncState): void {
    this.rows.set(sourceKey, {
      ...withoutLaneRun(state),
      ...laneRunFieldsFromRow(laneRunColumnsOf(this.rows.get(sourceKey))),
    });
    if (hasLaneRunRecord(laneRunFieldsFromRow(laneRunColumnsOf(state)))) {
      this.writeLaneRunColumns(sourceKey, laneRunColumnsOf(state));
    }
  }

  /** `sqliteLoadSyncState`'s two-row read, and its answer when no cursor row exists. */
  load(sourceKey: string): PersistedSyncState | null {
    const cursorRow = this.rows.get(sourceKey);
    const laneRun = laneRunFieldsFromRow(
      laneRunColumnsOf(this.rows.get(buildLaneRunSourceKey(sourceKey)))
    );
    if (!cursorRow) {
      return hasLaneRunRecord(laneRun)
        ? { ...emptySyncStateCursor(), ...laneRun }
        : null;
    }
    return { ...withoutLaneRun(cursorRow), ...laneRun };
  }

  /**
   * `sqliteAdvanceSyncState` names no lane-run column in either upsert branch,
   * so the row keeps whatever lane run it already had. A fake that dropped it
   * would make a stamp look self-clearing on the first successful batch.
   */
  advance(sourceKey: string, state: PersistedSyncState): void {
    this.rows.set(sourceKey, {
      ...withoutLaneRun(state),
      ...laneRunFieldsFromRow(laneRunColumnsOf(this.rows.get(sourceKey))),
    });
    this.advanceCalls.push({ sourceKey, state });
  }

  /** The stamp-only alias: `lane_gave_up_at` alone, on the lane-run row. */
  recordLaneGiveUp(sourceKey: string, gaveUpAt: string | null): void {
    assertWritableLaneRunColumns({ laneGaveUpAt: gaveUpAt });
    this.writeLaneRunColumns(sourceKey, { laneGaveUpAt: gaveUpAt });
  }

  recordLaneRun(sourceKey: string, run: PersistedLaneRun): void {
    assertWritableLaneRunColumns(run);
    this.laneRunWrites.push({ sourceKey, run });
    this.writeLaneRunColumns(sourceKey, run);
  }

  /** An upsert on the lane-run row; a missing row is created as an empty cursor, as the store does. */
  private writeLaneRunColumns(
    sourceKey: string,
    columns: Partial<PersistedLaneRun>
  ): void {
    const key = buildLaneRunSourceKey(sourceKey);
    const row = this.rows.get(key);
    this.rows.set(key, {
      ...withoutLaneRun(row ?? emptySyncStateCursor()),
      ...laneRunFieldsFromRow({ ...laneRunColumnsOf(row), ...columns }),
    });
  }
}

function laneRunColumnsOf(
  row: PersistedSyncState | undefined
): PersistedLaneRun {
  return {
    laneStalledSince: row?.laneStalledSince ?? null,
    laneGaveUpAt: row?.laneGaveUpAt ?? null,
    laneGaveUpReason: row?.laneGaveUpReason ?? null,
    laneGaveUpSource: row?.laneGaveUpSource ?? null,
  };
}

function withoutLaneRun(state: PersistedSyncState): PersistedSyncState {
  const {
    laneStalledSince: _stalledSince,
    laneGaveUpAt: _gaveUpAt,
    laneGaveUpReason: _reason,
    laneGaveUpSource: _source,
    ...cursor
  } = state;
  return cursor;
}
