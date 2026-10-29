/**
 * @file sync-lane-run-state.ts
 * @description PLN-2028 M1 (ISS-10053): the durable LANE RUN on `sync_state` —
 * `lane_stalled_since`, `lane_gave_up_at`, `lane_gave_up_reason` and
 * `lane_gave_up_source` (migration 0091_iss10053_sync_state_lane_run).
 *
 * Split out of `sync-cursor-state.ts` because these four columns are their own
 * seam. A different EVENT writes them — a lane giving up or opening a run, never
 * a prefix being acked — and for the session lane they live on a different ROW.
 *
 * THE ROW. A lane run is one per (lane, compute target), which the session lane's
 * live `source_key` does not name: see `buildLaneRunSourceKey`. Every function
 * here resolves that key itself, so callers keep passing the live key and cannot
 * pick the wrong row. A stamp already written under a session revision-key row is
 * NOT migrated (PLN-2028 D2) — the column was under a week old, and a lost stamp
 * costs one repeated 24h run, which is its documented cost.
 *
 * This module is the WRITES. The read projection the cursor load shares lives in
 * `sync-lane-run-row.ts` and the row key in
 * `agent-sync/sync-lane-run-key.ts`, so `sync-cursor-state.ts` never imports
 * this module. Writes route through `prisma.write`, as the cursor's do, and the
 * contract stamps a write needs to CREATE a row arrive as a value from the
 * delegate, which computes them for both writers.
 */

import { z } from "zod";
import {
  emptySyncStateCursor,
  LANE_RUN_COLUMN_SCHEMAS,
  type PersistedLaneRun,
} from "../agent-sync/sync-cursor-state-source.js";
import { buildLaneRunSourceKey } from "../agent-sync/sync-lane-run-key.js";
import type { DesktopPrisma } from "./prisma-client.js";
import type { SyncStateContractStamps } from "./sync-cursor-state.js";

/**
 * PLN-2028: write one lane's whole durable lane run for `sourceKey`'s lane-run
 * row. Every `null` clears its column; the four are named explicitly rather than
 * spread from `run`, so an unexpected key on a cross-process argument can never
 * reach another column.
 *
 * `update` touches ONLY these four columns (and `updatedAt`): a watermark, a
 * dead-letter set and the contract stamps belong to the cursor advance, and a
 * lane run must never rewrite them. `create` exists because a lane can open a run
 * or give up before it has ever persisted a cursor — a new install whose cloud
 * has been unreachable since first launch — and that run is exactly the one an
 * in-memory clock loses across the restarts such an install performs.
 *
 * A value outside its column's domain refuses the WHOLE write before anything is
 * written: see {@link assertWritableLaneRunColumns}.
 *
 * One atomic upsert, never a read-then-write.
 */
export function sqliteRecordLaneRun(
  prisma: DesktopPrisma,
  sourceKey: string,
  run: PersistedLaneRun,
  stamps: SyncStateContractStamps
): Promise<void> {
  return upsertLaneRunColumns(
    prisma,
    sourceKey,
    {
      laneStalledSince: run.laneStalledSince,
      laneGaveUpAt: run.laneGaveUpAt,
      laneGaveUpReason: run.laneGaveUpReason,
      laneGaveUpSource: run.laneGaveUpSource,
    },
    stamps
  );
}

/**
 * ISS-9418: record (or clear, with `null`) one lane's durable give-up stamp.
 *
 * PLN-2028: the stamp-only COMPATIBILITY ALIAS of {@link sqliteRecordLaneRun},
 * kept for a caller that predates the lane run. It writes to the same lane-run row
 * and touches `lane_gave_up_at` alone, so it neither clears nor invents an origin,
 * reason or producer that a newer writer recorded. Removing it needs explicit
 * human approval.
 */
export function sqliteRecordLaneGiveUp(
  prisma: Pick<DesktopPrisma, "write">,
  sourceKey: string,
  gaveUpAt: string | null,
  stamps: SyncStateContractStamps
): Promise<void> {
  return upsertLaneRunColumns(
    prisma,
    sourceKey,
    { laneGaveUpAt: gaveUpAt },
    stamps
  );
}

async function upsertLaneRunColumns(
  // ISS-9884: the write alone, so the transcript lane's store — which holds a
  // narrower client than the session lane's delegate — reaches the same writer
  // rather than restating this upsert.
  prisma: Pick<DesktopPrisma, "write">,
  sourceKey: string,
  columns: Partial<PersistedLaneRun>,
  stamps: SyncStateContractStamps
): Promise<void> {
  assertWritableLaneRunColumns(columns);
  const laneRunKey = buildLaneRunSourceKey(sourceKey);
  const updatedAt = new Date().toISOString();
  await prisma.write((client) =>
    client.syncState.upsert({
      where: { sourceKey: laneRunKey },
      create: {
        sourceKey: laneRunKey,
        // No cursor was ever persisted for this key, and this write must not
        // invent one: a NULL watermark is the first-run/full-backfill position,
        // which is what an absent row already means.
        ...emptySyncStateCursor(),
        ...columns,
        ...stamps,
        updatedAt,
      },
      update: { ...columns, updatedAt },
      select: { sourceKey: true },
    })
  );
}

/**
 * PLN-2028: refuse, by throwing, a lane-run write naming a value its own load
 * would reject ({@link LANE_RUN_COLUMN_SCHEMAS}). A stored lane run is then valid
 * or absent, so an empty stamp is never persisted to read back as "never gave
 * up". `null` clears a column and an unnamed column is untouched; neither is
 * checked.
 *
 * The whole write, not the bad column: dropping only that value would persist a
 * give-up without the reason or producer written beside it. A refusal reaches the
 * caller as any failed write does — `LaneRunRecord` names it through the lane's
 * write-failure hook and the next state change re-attempts — while the in-memory
 * run still governs this process.
 *
 * Exported so `test/fake-sync-state-table.ts` refuses exactly what the store does.
 */
export function assertWritableLaneRunColumns(
  columns: Partial<PersistedLaneRun>
): void {
  const parsed = LANE_RUN_WRITE_SCHEMA.safeParse(columns);
  if (!parsed.success) {
    const refused = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `refused a lane-run write outside its column domain: ${refused.join(", ")}`
    );
  }
}

/** Each lane-run column as a write may name it: absent, cleared, or in its domain. */
const LANE_RUN_WRITE_SCHEMA = z.object({
  laneStalledSince: LANE_RUN_COLUMN_SCHEMAS.laneStalledSince.nullish(),
  laneGaveUpAt: LANE_RUN_COLUMN_SCHEMAS.laneGaveUpAt.nullish(),
  laneGaveUpReason: LANE_RUN_COLUMN_SCHEMAS.laneGaveUpReason.nullish(),
  laneGaveUpSource: LANE_RUN_COLUMN_SCHEMAS.laneGaveUpSource.nullish(),
} satisfies Record<keyof PersistedLaneRun, z.ZodTypeAny>);
