/**
 * @file session-analytics-maintenance.ts
 * @description Boot-only session-analytics maintenance passes, extracted from
 * write-core.ts (ISS-4851). These five idempotent, background boot passes — the
 * session-analytics backfill, its headless re-derivation, the imported
 * agent-turn heal, the turn-bucket backfill, and the headless turn-bucket
 * re-derivation — are invoked ONLY from the `sqlite.ts` boot orchestrator's
 * background maintenance chain, never on the import hot path. They read the
 * corpus and re-run the shared Layer-A rollup / budget primitives that live in
 * session-analytics-rollup.ts (ISS-4937 moved them out of write-core.ts), the
 * watermark/bump helpers still in write-core.ts, and rebuildSessionTurnBuckets
 * from turn-buckets.ts — so the dependency runs one way only:
 * session-analytics-maintenance.ts -> session-analytics-rollup.ts /
 * write-core.ts / turn-buckets.ts, never back.
 */

import type { DesktopPrisma } from "./prisma-client.js";
import {
  chunkSessionIdsByMetadataBudget,
  SESSION_ANALYTICS_BACKFILL_CHUNK,
  SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
  upsertSessionAnalyticsRollupBatch,
} from "./session-analytics-rollup.js";
import {
  headlessMetadataSql,
  transcriptAssistantTurnsSql,
} from "./session-analytics-sql.js";
import {
  bumpSessionsUpdatedAt,
  chunkWatermark,
} from "./session-sync-watermark.js";
import { rebuildSessionTurnBuckets } from "./turn-buckets.js";

/**
 * FEA-3132: one-time backfill of `session_turn_bucket` for an existing install
 * upgrading to migration 0018. New/reprocessed sessions get their buckets at
 * ingest (rebuildSessionTurnBuckets, in the rollup tx); this populates the
 * PRE-existing corpus so the Insights autonomy trend + activity heatmap aren't
 * empty until each old session is next reprocessed. Chunked by the same
 * metadata-byte budget as the analytics backfill so the one-time json_each scan
 * stays bounded.
 *
 * Targets only sessions NOT yet represented in the bucket table (NOT EXISTS),
 * NOT a whole-table COUNT>0 gate. This pass runs at the tail of the background
 * boot-maintenance chain, but live ingest (processEvent -> rollup ->
 * rebuildSessionTurnBuckets) is NOT gated behind that chain and populates
 * buckets concurrently. A COUNT>0 gate would lose that race: a single live
 * ingest before this pass would flip the gate and strand the entire historical
 * corpus un-backfilled forever (once-per-install). Selecting only un-bucketed
 * sessions is both race-free and idempotent across boots. Sessions with metadata
 * but zero qualifying turns (no timestamped human/assistant message) legitimately
 * yield no rows and are re-checked on each boot — a bounded cost over that
 * minority, never a re-scan of the full corpus.
 */
export async function backfillSessionTurnBuckets(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const rows = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     WHERE s.metadata IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM session_turn_bucket b WHERE b.session_id = s.id
       )`
  );
  if (rows.length === 0) {
    return;
  }
  const ids = rows.map((r) => r.id);
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) => rebuildSessionTurnBuckets(tx, chunk))
      );
      done += chunk.length;
    } catch (error) {
      log(
        `session-turn-bucket backfill failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(`session-turn-bucket backfill complete: ${done}/${ids.length}`);
}

/**
 * FEA-3266 (FEA-3616 follow-up): re-derive `session_turn_bucket` for headless
 * sessions that still carry a stale `turn_kind = 'human'` bucket after the
 * headless classifier broadened (sdk-/exec/bypassPermissions).
 *
 * The `is_human` rollup self-heals: `recomputeHeadlessSessionAnalytics` selects
 * every `is_human = 1` headless session and re-runs the rollup, which rebuilds
 * that session's turn buckets in the SAME transaction (see
 * `upsertSessionAnalyticsRollupBatch` -> `rebuildSessionTurnBuckets`). But it
 * only selects sessions ABOVE the `is_human` threshold
 * (SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD = 2 human turns). A newly-headless
 * session with a SINGLE human turn stays `is_human = 0` (below the threshold),
 * so the recompute skips it — yet its per-turn bucket still classifies that lone
 * turn as `human` under the pre-broadening predicate. The Insights autonomy
 * trend + activity heatmap read `turn_kind` straight from this table, so that
 * stale `human` bucket misreports a headless turn as human-steered.
 *
 * Re-derive exactly those rows. Convergent/idempotent: once rebuilt a headless
 * session has no `human` bucket, so the next boot selects nothing. Bounded to
 * the mis-bucketed set. Local-only — `session_turn_bucket` is a desktop Insights
 * materialization (not synced); the cloud `isHuman` correction rides the
 * `recomputeHeadlessSessionAnalytics` `updated_at` bump. `backfillSessionTurnBuckets`
 * (which only fills sessions with NO buckets) can't cover this: these sessions
 * already HAVE buckets, just stale ones.
 *
 * FEA-3597 — this pass keeps its name, its predicate and its boot slot, but its
 * OUTPUT semantics changed. It used to CONVERT the stale `human` row into an
 * `agent` row. Agent rows no longer come from `$.messages` at all, so for a
 * headless session with no `$.tokenSeries` it now DELETES that row and produces
 * nothing in its place. Both the FEA-3266 intent (a headless turn must never
 * report as human-steered) and convergence (a session with no `human` bucket is
 * not re-selected) still hold — but a reader comparing this comment to the
 * observed behaviour would otherwise conclude the pass was broken.
 */
export async function recomputeHeadlessTurnBuckets(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const stale = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT DISTINCT s.id
       FROM sessions s
       JOIN session_turn_bucket b ON b.session_id = s.id
      WHERE b.turn_kind = 'human'
        AND ${headlessMetadataSql("s.metadata")}`
  );
  if (stale.length === 0) {
    return;
  }
  const ids = stale.map((r) => r.id);
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) => rebuildSessionTurnBuckets(tx, chunk))
      );
      done += chunk.length;
    } catch (error) {
      log(
        `headless turn-bucket recompute failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `headless turn-bucket recompute complete (FEA-3266): ${done}/${ids.length}`
  );
}

/**
 * FEA-2038: one-time/idempotent backfill of the analytics rollups for every
 * session that lacks a `session_analytics` row (e.g. existing stores upgrading to
 * 0004, or any session imported before this code). Runs after migrations at db
 * open. Set-based: collapses the former N per-session transactions into
 * ⌈missing/CHUNK⌉ chunked transactions via `upsertSessionAnalyticsRollupBatch`,
 * which mirrors the per-session rollup SQL exactly. A failed chunk is logged and
 * skipped; remaining chunks still run.
 *
 * SYNC NOTE (FEA-3485): unlike the bounded heal passes below
 * (`recomputeHeadlessSessionAnalytics`, `repriceUnpricedTokenUsage`,
 * `recomputeImportedAgentTurnAnalytics`), this pass deliberately does NOT bump
 * `sessions.updated_at`. It materializes net-new analytics for EVERY session
 * lacking a row — the whole corpus on the first boot after migration 0004. A
 * blanket bump would stamp one identical `now` across every session, collapsing
 * them onto a single top watermark; the sync cursor then folds all of them into
 * `observedIdsAtTopUpdatedAt` (agent-session-sync-service.ts), which is persisted
 * UNCAPPED to the SyncState JSON column — an O(corpus) regression. It is also
 * unnecessary on a fresh store, where the first sync uploads every session with
 * its analytics regardless of the watermark. The narrow residual gap (a session
 * synced under a pre-analytics app version, then upgraded) would need a
 * per-session (not single-`now`) re-sync trigger and is left for separate
 * triage.
 */
export async function backfillSessionAnalytics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  // Anti-join (sessions without a session_analytics row) — raw read on the one
  // client.
  const missing = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     LEFT JOIN session_analytics sa ON sa.session_id = s.id
     WHERE sa.session_id IS NULL`
  );
  if (missing.length === 0) {
    return;
  }
  const ids = missing.map((row) => row.id);
  const now = new Date().toISOString();
  // FEA-3132 (D6): budget chunks by summed metadata bytes (secondary count bound
  // = chunkSize) so a large transcript can't balloon the json_each rollup scan.
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollupBatch(tx, chunk, now, { log })
        )
      );
      done += chunk.length;
    } catch (error) {
      log(
        `session-analytics backfill failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(`session-analytics backfill complete: ${done}/${ids.length}`);
}

/**
 * FEA-2870: one-time/idempotent boot pass that re-derives the analytics rollup
 * for headless/autonomous sessions still marked `is_human = 1` by a pre-fix
 * rollup. The rollup SQL now forces `is_human = 0` for headless sessions (see
 * `headlessMetadataSql`), so re-running it flips the stale rows — correcting the
 * autonomy trend and the Human/Agent heatmap split for existing data. Bounded to
 * the mis-marked set and chunked exactly like `backfillSessionAnalytics`.
 *
 * SYNC INVARIANT: `session_analytics.is_human` syncs to the cloud as-is (cloud
 * `isHuman`, the autonomy-trend / Human-vs-Agent split), so each healed chunk
 * also advances `sessions.updated_at` in the same transaction (see
 * `bumpSessionsUpdatedAt`) — an install that already uploaded the mis-marked row
 * would otherwise keep the stale `isHuman` in the cloud dashboard until an
 * unrelated mutation touched the session (same pattern as
 * `recomputeImportedAgentTurnAnalytics` / `healCacheCostSplit`). Convergent: the
 * fixed rollup forces `is_human = 0`, so the next boot selects no rows and the
 * watermark is not re-bumped.
 */
export async function recomputeHeadlessSessionAnalytics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const stale = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     JOIN session_analytics sa ON sa.session_id = s.id
     WHERE sa.is_human = 1
       AND ${headlessMetadataSql("s.metadata")}`
  );
  if (stale.length === 0) {
    return;
  }
  const ids = stale.map((row) => row.id);
  const now = new Date().toISOString();
  // FEA-3132 (D6): metadata-byte-budgeted chunks (see backfillSessionAnalytics).
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    // FEA-3485: per-chunk watermark so a multi-chunk heal never collapses onto
    // one shared top timestamp (see `chunkWatermark` / `bumpSessionsUpdatedAt`).
    const chunkNow = chunkWatermark(now, chunkIndex);
    try {
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          await upsertSessionAnalyticsRollupBatch(tx, chunk, chunkNow, { log });
          await bumpSessionsUpdatedAt(tx, chunk, chunkNow);
        })
      );
      done += chunk.length;
    } catch (error) {
      log(
        `headless session-analytics recompute failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `headless session-analytics recompute complete (FEA-2870): ${done}/${ids.length}`
  );
}

/**
 * FEA-3226: one-time/idempotent boot pass that re-derives the analytics rollup
 * for imported sessions whose stored `agent_turns` disagrees with the
 * transcript-first count (metadata `$.assistantMessages`). The pre-fix rollup
 * counted `event_type LIKE '%assistant%'`, which matches no importer-written
 * event type, so every imported session froze `agent_turns = 0`. This PR does
 * not bump `DATA_REVISION` (parser output is unchanged — only the rollup
 * derivation), so those rows are never re-imported and would keep the stale
 * zero indefinitely without this repair (same rationale as the FEA-2879
 * compacted-cost repair). Convergent: the fixed rollup stores exactly the
 * metadata count, so a healed row is never selected again. Bounded to the
 * disagreeing set and chunked exactly like `backfillSessionAnalytics`.
 *
 * SYNC INVARIANT: cloud sync selects sessions by `sessions.updated_at`
 * (`listUpdatedSessionCursorRows`), so each healed chunk also advances that
 * watermark in the same transaction — an install that already uploaded the
 * frozen zero would otherwise keep `agentTurns = 0` in the cloud until some
 * unrelated mutation touched the session (same pattern as
 * `healCacheCostSplit`). Convergence keeps this a one-time re-sync: the next
 * boot selects no rows, so nothing is re-bumped.
 */
export async function recomputeImportedAgentTurnAnalytics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const transcriptTurns = transcriptAssistantTurnsSql("s.metadata");
  const stale = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     JOIN session_analytics sa ON sa.session_id = s.id
     WHERE ${transcriptTurns} IS NOT NULL
       AND sa.agent_turns != ${transcriptTurns}`
  );
  if (stale.length === 0) {
    return;
  }
  const ids = stale.map((row) => row.id);
  const now = new Date().toISOString();
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    ids,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    // FEA-3485: per-chunk watermark (see `chunkWatermark`) bounds the sync
    // cursor's top-timestamp group to a single chunk on a multi-chunk heal.
    const chunkNow = chunkWatermark(now, chunkIndex);
    try {
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          await upsertSessionAnalyticsRollupBatch(tx, chunk, chunkNow, { log });
          await bumpSessionsUpdatedAt(tx, chunk, chunkNow);
        })
      );
      done += chunk.length;
    } catch (error) {
      log(
        `imported agent-turn recompute failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `imported agent-turn recompute complete (FEA-3226): ${done}/${ids.length}`
  );
}
