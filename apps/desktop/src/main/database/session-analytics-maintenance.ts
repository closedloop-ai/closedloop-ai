/**
 * @file session-analytics-maintenance.ts
 * @description Boot-only session-analytics maintenance passes, extracted from
 * write-core.ts (ISS-4851). These seven idempotent, background boot passes — the
 * session-analytics backfill, its headless re-derivation, the imported
 * agent-turn heal, the legacy est_cost re-derivation, the turn-bucket backfill,
 * the headless turn-bucket re-derivation, and the legacy-message agent
 * turn-bucket re-derivation (ISS-8259) — are invoked ONLY from the
 * `sqlite.ts` boot orchestrator's background maintenance chain, never on the
 * import hot path. They read the corpus and re-run the shared Layer-A rollup /
 * budget primitives that live in session-analytics-rollup.ts (ISS-4937 moved
 * them out of write-core.ts), the watermark/bump helpers still in write-core.ts,
 * the shared cost SQL fragments in token-cost-writes.ts, and
 * rebuildSessionTurnBuckets from turn-buckets.ts — so the dependency runs one
 * way only: session-analytics-maintenance.ts -> session-analytics-rollup.ts /
 * write-core.ts / token-cost-writes.ts / turn-buckets.ts, never back.
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
import {
  sessionEstimatedCostSql,
  webSearchCostSql,
} from "./token-cost-writes.js";
import {
  deriveSessionTurnBuckets,
  rebuildSessionTurnBuckets,
} from "./turn-buckets.js";

/**
 * FEA-3132: one-time backfill of `session_turn_bucket` for an existing install
 * upgrading to migration 0018. New/reprocessed sessions get their buckets at
 * ingest (rebuildSessionTurnBuckets, in the rollup tx); this populates the
 * PRE-existing corpus so the Insights autonomy trend + activity heatmap aren't
 * empty until each old session is next reprocessed. Chunked by the same
 * metadata-byte budget as the analytics backfill so the one-time scan stays
 * bounded — it is no longer a `json_each` scan, which FEA-3132 removed from this
 * path (see `rebuildSessionTurnBuckets`); the budget still governs how much
 * metadata one transaction parses.
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
 * FEA-3597 / ISS-8259 — this pass keeps its name, its predicate and its boot
 * slot, and its OUTPUT semantics have now moved twice. Originally it CONVERTED
 * the stale `human` row into an `agent` row. FEA-3597 took agent rows off
 * `$.messages` entirely, so for a headless session with no `$.tokenSeries` the
 * pass DELETED that row and produced nothing in its place. ISS-8259 restored the
 * conversion for exactly that shape: the legacy `$.messages` fallback promotes a
 * headless session's injected `human` prompts back to `agent`, so the rebuild
 * once again emits an agent row rather than a hole. The FEA-3266 intent (a
 * headless turn must never report as human-steered) held under all three, and
 * convergence still holds — a session with no `human` bucket is not re-selected.
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

/**
 * ISS-7820 (review, davetho): re-derive `session_analytics.est_cost` for
 * LEGACY rows migration 0072 copied across verbatim — the pre-fix confident
 * numbers the widened column now has a way to say "unknown" instead of.
 *
 * 0072 deliberately reinterprets nothing: a stored `0` stays `0`, because the
 * migration cannot know which zeros were real. Its own header says those rows
 * "converge on the new distinction the next time any analytics rollup runs for
 * them" — and for a completed session that pass may never come.
 * `backfillSessionAnalytics` anti-joins on a MISSING analytics row, so an
 * upgraded install (which HAS one for every session) is skipped by it entirely,
 * leaving the whole pre-upgrade corpus on the old semantics indefinitely. This
 * is the bounded, idempotent pass that closes that.
 *
 * The stale set is selected with the SAME `sessionEstimatedCostSql` the rollup
 * writes, so the selector cannot drift from the writer: a row qualifies when it
 * stores a number while that expression would now produce NULL — the
 * partly/un-priced window, and the "$0.00 with nothing priced and no web search"
 * zero. Convergent, therefore idempotent across boots: the rollup writes NULL
 * for exactly those rows, and a NULL `est_cost` is not selected again.
 *
 * NO `bumpSessionsUpdatedAt`, unlike the two heals above, and that is deliberate
 * rather than an omission. ISS-7818 makes the wire capable of carrying this
 * unknown as `null`, but replaying the historical corpus is the separate
 * ISS-8517 backfill. This repair stays local-read-correct now (Insights, branch
 * cost evidence) without silently turning a producer contract flip into an
 * unbounded re-sync. Same no-bump posture, for the same "do not stamp a value we
 * cannot stand behind" reason, that `backfillSessionAnalytics` documents.
 */
export async function recomputeLegacySessionAnalyticsCost(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const derivedCost = sessionEstimatedCostSql({
    pricedRowsExpr: "COALESCE(tok.priced_rows, 0)",
    tokenCostUsdExpr: "COALESCE(tok.est_cost, 0)",
    tokenUsageRowsExpr: "COALESCE(tok.token_usage_rows, 0)",
    webSearchCostUsdExpr: webSearchCostSql("s.metadata"),
  });
  const stale = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     JOIN session_analytics sa ON sa.session_id = s.id
     LEFT JOIN (
       SELECT
         session_id,
         COALESCE(SUM(cost_usd_estimated), 0) AS est_cost,
         COUNT(cost_usd_estimated) AS priced_rows,
         COUNT(*) AS token_usage_rows
       FROM token_usage GROUP BY session_id
     ) tok ON tok.session_id = s.id
     WHERE sa.est_cost IS NOT NULL
       AND (${derivedCost}) IS NULL`
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
        `legacy analytics cost recompute failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `legacy analytics cost recompute complete (ISS-7820): ${done}/${ids.length}`
  );
}

/**
 * ISS-8259: re-derive `session_turn_bucket` for a session that synced NO token
 * events and therefore has no `agent` bucket, so the restored legacy
 * `$.messages` Agent fallback reaches an ALREADY-imported corpus.
 *
 * Neither existing pass covers this shape. `backfillSessionTurnBuckets` selects
 * only sessions with NO buckets at all, and a token-event-less session that is
 * not headless already has its `human` rows — so it would keep reading zero
 * Agent turns until something else happened to reprocess it, which for a
 * finished session is never. `recomputeHeadlessTurnBuckets` selects only
 * HEADLESS sessions carrying a stale `human` bucket, which is the complementary
 * half. Without this pass the derivation change is inert on every existing
 * install and the cross-surface parity the ticket exists to establish would hold
 * only for sessions imported after the upgrade.
 *
 * ISS-8398 gave this pass a SECOND shape on the same selector: a session whose
 * assistant rows are ALL zone-less has no `agent` bucket, so it is selected here
 * and heals. Regression coverage: the ISS-8398 case in
 * legacy-message-agent-turn-bucket-heal.test.ts.
 *
 * ISS-9864 gave it a THIRD: a token-event-less session with MORE than 100
 * messages, bucketed under the 100-row window ISS-8259 applied to match the
 * cloud's capped read. The derivation now reads the whole local array (the
 * cloud reads the synced `metadata.agentTurnTimestamps` key instead), and
 * because this pass hydrates full metadata per chunk and re-derives through the
 * same pure function, rows 101+ are added on the next boot with no
 * `DATA_REVISION` bump. Regression coverage: the ISS-9864 case in the same file.
 *
 * A MIXED session — some rows canonical, some zone-less — already HAS an `agent`
 * bucket, so the `NOT EXISTS (… turn_kind='agent')` clause this pass used to
 * carry never re-selected it, and its zone-less rows stayed uncounted on an
 * upgraded install while a fresh import of the same session counted them
 * (whitlockk review). That clause is GONE: the selector now admits every
 * token-event-less session carrying `$.messages`, and what decides a write is
 * whether the session's DERIVED buckets differ from its STORED ones.
 *
 * That comparison is the convergence mechanism, and it is why this needs no
 * `*_backfill_seen` high-water table. `rebuildSessionTurnBuckets` re-derives
 * from the same pure function the comparison is taken over, so a rebuilt
 * session's stored rows EQUAL its derived rows and the next boot writes
 * nothing. A marker would only record that the pass had run; converging on the
 * rows themselves also re-heals a bucket set that anything else corrupted, and
 * cannot be defeated by a marker written before a later derivation change.
 *
 * The cost of dropping the clause is bounded by the population, not by this
 * pass: `NOT EXISTS (… token_events …)` already confines it to the LEGACY
 * corpus — every modern session has token events — and that corpus was already
 * hydrated here on every boot, because an all-human session matched every
 * clause and derived no agent row. The widening adds the legacy sessions that
 * DO hold an agent bucket, read through the same byte-budget chunker.
 *
 * Both shapes live in one population — metadata persisted before `toIso`
 * normalized every parser's output to a `Z` form — so do not read "no current
 * collector emits zone-less" as retiring either.
 *
 * Deliberately NOT a `DATA_REVISION` bump. Parser output is unchanged — only the
 * bucket derivation reading it — so a full re-import would re-parse the entire
 * corpus to rewrite four rows, and the golden protocol is explicit that bumping
 * a version marker records an approved semantic decision rather than creating
 * one.
 *
 * The `token_events` NOT EXISTS is the WHOLE selector-side gate, and it is the
 * same one `deriveSessionTurnBuckets` splits its agent half on — which is in
 * turn the twin of the cloud's `NOT EXISTS (… agent_session_token_events …)`.
 * An earlier revision ANDed an empty-`$.tokenSeries` clause beside it; the
 * ISS-8259 review removed it along with the matching disjunct in the derivation,
 * because a session with a populated series and no token-event rows is counted
 * by the cloud from `$.messages` and must be selectable here for the same
 * reason. Keeping the clause would have made this pass skip exactly the
 * population the derivation had just started reading differently.
 *
 * The synthesized-token-event case the old clause was reaching for is still
 * handled, and by this gate alone: when `$.tokenSeries` is empty and
 * `$.tokensByModel` is not, the importer writes one token event per model, so
 * `NOT EXISTS` is false and the session is never selected. `tokensByModel` is
 * not persisted into `metadata`, which is why the question is asked of the table
 * rather than of the blob.
 *
 * CONVERGENT, and the JS filter in the chunk loop is what makes it so. Once
 * rebuilt, a session HAS an `agent` bucket and is never selected again. A
 * session whose messages are all human satisfies every SQL clause but would
 * derive no agent row, so it is dropped before the write rather than being
 * DELETE-then-INSERTed back to its existing rows on every boot for the life of
 * the install. What remains is a bounded read: those sessions still come back
 * from the selector each boot and are filtered in memory, which is the same
 * cheap re-check `backfillSessionTurnBuckets` already accepts for its own
 * zero-qualifying-turn minority — but no longer a write.
 *
 * BOUNDED, which is why the selector returns IDS ONLY and metadata is read per
 * chunk inside the loop (ISS-8259 review). Selecting `metadata` alongside the
 * ids materializes every candidate's blob — the full `$.messages` array, which
 * the local store does not truncate — into one JS array before
 * `chunkSessionIdsByMetadataBudget` has bounded anything, so on an upgraded
 * install with a large legacy history the pass could OOM the db-host process on
 * the read that was supposed to be budgeted. That is the invariant stated in
 * this directory's AGENTS.md, and the byte budget can only hold once the read
 * it governs happens after it.
 *
 * FAIL-SOFT ON MALFORMED METADATA, deliberately. The JSON1 functions RAISE on a
 * row whose `metadata` is not valid JSON, and one such row would abort the whole
 * selector and leave every other target stale forever — the boot chain catches
 * it, so the failure is silent.
 *
 * The guard is a nested CASE, not a chain of ANDed predicates (ISS-8259 review,
 * whitlockk). SQLite does not promise to evaluate the terms of an AND in written
 * order — the planner may reorder them — so `json_valid(metadata) AND
 * json_type(metadata, '$.messages') = 'array'` does NOT establish that the
 * `json_type` call only ever sees valid JSON. CASE is the construct whose branch
 * order IS guaranteed, so each JSON1 call is reached only once the branch above
 * it has proved its input safe. This is the same shape `session-aggregate-
 * filters.ts` and `dashboard-queries.ts` already use over this column, and it
 * matches `deriveSessionTurnBuckets`, which returns `[]` rather than throwing on
 * the same input.
 *
 * `json_array_length` is a scalar JSON1 function, NOT `json_each`: the virtual
 * table expansion FEA-3132 removed from this path was both the corpus-scale perf
 * sink and the @libsql native SIGTRAP trigger, and nothing here reintroduces it.
 * That is also why the "does any message qualify" question is answered in JS.
 */
export async function recomputeLegacyMessageAgentTurnBuckets(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const candidates = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id
       FROM sessions s
      WHERE CASE
              WHEN s.metadata IS NULL OR json_valid(s.metadata) = 0 THEN 0
              WHEN json_type(s.metadata, '$.messages') IS NOT 'array' THEN 0
              ELSE json_array_length(s.metadata, '$.messages') > 0
            END
        AND NOT EXISTS (
          SELECT 1 FROM token_events te WHERE te.session_id = s.id
        )`
  );
  if (candidates.length === 0) {
    return;
  }
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    candidates.map((row) => row.id),
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    Math.max(1, Math.floor(chunkSize))
  );
  let done = 0;
  let qualified = 0;
  for (const chunk of chunks) {
    try {
      // Metadata is read ONE chunk at a time, inside the loop the byte budget
      // bounds. Selecting it alongside the ids above would materialize every
      // candidate's blob — `$.messages` included — before the packer ever ran,
      // which is precisely the "never hydrate the corpus into JS" invariant in
      // this directory's AGENTS.md and the shape that OOMs the db-host process.
      const placeholders = chunk.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await prisma.client.$queryRawUnsafe<
        { id: string; metadata: string | null }[]
      >(
        `SELECT id, metadata FROM sessions WHERE id IN (${placeholders})`,
        ...chunk
      );
      // Rebuild ONLY the sessions whose stored rows actually disagree with the
      // current derivation. The SQL cannot ask "does any `$.messages` element
      // qualify" without `json_each`, which FEA-3132 removed from this path, so
      // the question is answered from the same derivation the write uses.
      // Without this filter the pass is a DELETE-then-INSERT of unchanged rows
      // on every boot for every session whose messages are all human — real
      // repeated writes, not a re-check.
      //
      // ISS-8398 made it a DIFFERENCE test rather than "would gain an agent
      // row", so a MIXED session — already holding an agent bucket from its
      // canonical rows, still missing its zone-less ones — is repaired too.
      const storedRows = await prisma.client.$queryRawUnsafe<
        {
          session_id: string;
          ts: string;
          turn_kind: string;
          turn_count: number | bigint;
        }[]
      >(
        `SELECT session_id, ts, turn_kind, turn_count
           FROM session_turn_bucket
          WHERE session_id IN (${placeholders})`,
        ...chunk
      );
      const storedBySession = new Map<string, TurnBucketShape[]>();
      for (const stored of storedRows) {
        const list = storedBySession.get(stored.session_id) ?? [];
        // `turn_count` is a bare INTEGER column, so the adapter can hand it
        // back as a `bigint`; the derivation's counts are JS numbers, and an
        // uncoerced 1n would make every fingerprint differ and every session
        // rebuild on every boot.
        list.push({
          ts: stored.ts,
          turnKind: stored.turn_kind,
          turnCount: Number(stored.turn_count),
        });
        storedBySession.set(stored.session_id, list);
      }
      const ids = rows
        .filter((row) => {
          const derived = deriveSessionTurnBuckets(row.id, row.metadata, false);
          // An empty derivation is NOT treated as "delete what is stored".
          // Malformed or absent metadata derives nothing, and converging on it
          // would drop a session's existing human rows on the strength of a
          // blob this pass cannot read — a repair that destroys data.
          if (derived.length === 0) {
            return false;
          }
          return (
            turnBucketFingerprint(derived) !==
            turnBucketFingerprint(storedBySession.get(row.id) ?? [])
          );
        })
        .map((row) => row.id);
      qualified += ids.length;
      if (ids.length === 0) {
        continue;
      }
      await prisma.write((client) =>
        client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ids))
      );
      done += ids.length;
    } catch (error) {
      log(
        `legacy-message agent turn-bucket recompute failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  // Silent when nothing qualified. A session whose messages are all human
  // matches every SQL clause on every boot and derives rows identical to the
  // stored ones, so logging unconditionally would emit a line per boot for the
  // life of the install — and the convergence contract this pass is built
  // around is precisely "no write, and no noise, once there is nothing left to
  // heal".
  if (qualified > 0) {
    log(
      `legacy-message agent turn-bucket recompute complete (ISS-8259/ISS-8398): ${done}/${qualified}`
    );
  }
}

/** One turn bucket, reduced to the fields {@link turnBucketFingerprint} compares. */
type TurnBucketShape = {
  ts: string;
  turnKind: string;
  turnCount: number;
};

/**
 * ISS-8398: an order-independent fingerprint of one session's turn buckets.
 *
 * This is what makes the mixed-session repair converge WITHOUT a
 * `*_backfill_seen` marker. `rebuildSessionTurnBuckets` re-derives from the
 * same pure function this is taken over, and the selector guarantees the
 * session has no token events, so the rebuild's `hasTokenEvents` argument is
 * the `false` used here — a rebuilt session's stored rows therefore EQUAL its
 * derived rows, and the next boot finds no difference and writes nothing.
 *
 * Sorted because neither side has a guaranteed order: the derivation walks
 * `$.messages` while the read is an unordered `SELECT`, so comparing
 * positionally would report a difference on every boot and rebuild forever.
 */
function turnBucketFingerprint(rows: TurnBucketShape[]): string {
  return rows
    .map((row) => `${row.ts}\0${row.turnKind}\0${row.turnCount}`)
    .sort()
    .join("\u0001");
}
