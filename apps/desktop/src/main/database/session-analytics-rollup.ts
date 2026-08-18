/**
 * @file session-analytics-rollup.ts
 * @description The session-analytics rollup WRITE primitives, extracted from
 * write-core.ts (ISS-4937) to shrink that grandfathered file. This is the
 * Layer-A rollup core: it (re)computes `session_analytics` +
 * `session_tool_analytics` for one session or a set of sessions
 * (`upsertSessionAnalyticsRollup` / `upsertSessionAnalyticsRollupBatch`) —
 * doing every human/agent-turn, is_human, and error-event classification ONCE
 * at ingest instead of on every dashboard read — and owns the memory-budget
 * chunking (`SESSION_ANALYTICS_BACKFILL_CHUNK`,
 * `SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES`,
 * `chunkSessionIdsByMetadataBudget`) that keeps each batch's `json_each` scan
 * inside the db-host worker's heap.
 *
 * Pure LEAF: imports only leaf modules (the SQL fragments from
 * ./session-analytics-sql.js, the packer from ./session-analytics-chunking.js,
 * `webSearchCostSql` from ./token-cost-writes.js, and the component-usage /
 * turn-bucket materializers), never write-core.js / live-hook.js. Its consumers
 * import FROM here one-directionally — write-core's import phase
 * (`importPhaseDerivedRollups`), ./sqlite.js (the boot orchestrator's
 * maintenance chain), ./session-analytics-maintenance.js,
 * ./token-cost-maintenance.js, and ./billing-mode-heal.js — so there is no
 * cycle.
 */
import {
  ensureStoredAgentComponentInvocations,
  rebuildAgentComponentSessionUsageFromInvocations,
} from "./component-invocations.js";
import { toolInvocationPredicate } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { packIdsByMetadataBudget } from "./session-analytics-chunking.js";
import {
  headlessMetadataSql,
  transcriptAssistantTurnsSql,
} from "./session-analytics-sql.js";
import { webSearchCostSql } from "./token-cost-writes.js";
import { rebuildSessionTurnBuckets } from "./turn-buckets.js";

/** Human-turn threshold for the session human/agent classification (mirrors
 * local-insights `HUMAN_TURN_THRESHOLD`). A session is "human" when it has >= this
 * many genuine human turns — counted transcript-first from `role:"human"`
 * messages in metadata `$.messages`, falling back to hook-captured user/prompt
 * events only when no parsed transcript exists (FEA-2641). Kept in sync with
 * local-insights by a guard test. */
const SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD = 2;

/**
 * FEA-2038: (re)compute the per-session analytics rollup for one session from its
 * events / token_usage rows and upsert it into `session_analytics` +
 * `session_tool_analytics`. All classification (human/agent turns, is_human,
 * error events) happens HERE, once, at ingest — mirroring the predicates the
 * dashboard insights used to run on every read. SQLite dialect.
 */
export async function upsertSessionAnalyticsRollup(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string,
  options: SessionAnalyticsRollupOptions
): Promise<void> {
  // The single-session rollup is the one-element case of the set-based batch.
  // Delegate so the (large) aggregate/classification SQL lives in ONE place and
  // the import-time path and the boot backfill can never drift apart.
  await upsertSessionAnalyticsRollupBatch(tx, [sessionId], now, options);
}

/** Max session ids per rollup transaction. Bounds the placeholder/parameter
 * count of the set-based upsert and keeps each commit (one fsync) modest while
 * still collapsing N per-session transactions into ⌈N/CHUNK⌉.
 *
 * FEA-3056: this ALSO bounds peak memory. `upsertSessionAnalyticsRollupBatch`
 * runs a `json_each` scan over EVERY message of EVERY session in the batch
 * (metadata `$.messages`) to count human/agent turns. At 500, a batch of
 * sessions with large transcripts materialized a multi-GB intermediate in the
 * db-host worker and blew its `--max-old-space-size` ceiling (exit code 5 →
 * crash-loop → no data anywhere). Keep it small so the per-batch scan stays
 * bounded; the extra commits are cheap next to a worker OOM. */
export const SESSION_ANALYTICS_BACKFILL_CHUNK = 25;

// FEA-3132 (D6): summed-metadata byte budget per rollup chunk. The CHUNK count
// above bounds the number of SESSIONS per rollup transaction, but
// upsertSessionAnalyticsRollupBatch runs a json_each scan over EVERY message of
// EVERY session in the chunk — so the intermediate materialization scales with
// TOTAL messages, not session count. One ~12 MB transcript blob can balloon a
// 25-session chunk past the db-host heap (exit code 5). Budgeting each chunk by
// summed length(metadata) makes a single oversized session its own chunk and
// caps every chunk's json_each scan regardless of transcript size. 8 MiB is a
// generous per-chunk metadata budget that still packs many small sessions.
export const SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * FEA-3132 (D6): look up each session's metadata byte length (in bounded
 * sub-batches so the IN-list never grows unbounded) and pack the ids into
 * metadata-budgeted chunks via {@link packIdsByMetadataBudget}. Missing rows
 * default to 0 bytes. Order-preserving.
 */
export async function chunkSessionIdsByMetadataBudget(
  prisma: DesktopPrisma,
  ids: string[],
  maxBytes: number = SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
  maxCount: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<string[][]> {
  const LOOKUP_BATCH = 500;
  const sizeById = new Map<string, number>();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const batch = ids.slice(i, i + LOOKUP_BATCH);
    const placeholders = batch.map((_, j) => `$${j + 1}`).join(", ");
    const rows = await prisma.client.$queryRawUnsafe<
      { id: string; n: number | bigint }[]
    >(
      // `length(metadata)` on a TEXT column counts CHARACTERS, not bytes, so
      // multi-byte (non-ASCII) metadata would under-report and let the packer
      // exceed SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES. Cast to BLOB so
      // `length` returns the true UTF-8 byte count the packer budgets against.
      `SELECT id, COALESCE(length(CAST(metadata AS BLOB)), 0) AS n FROM sessions WHERE id IN (${placeholders})`,
      ...batch
    );
    for (const row of rows) {
      sizeById.set(row.id, Number(row.n));
    }
  }
  const idBytes = ids.map((id) => ({ id, bytes: sizeById.get(id) ?? 0 }));
  return packIdsByMetadataBudget(idBytes, maxBytes, maxCount);
}

/**
 * FEA-2038: set-based (re)compute of the analytics rollups for an explicit set
 * of session ids, in ONE transaction. Mirrors `upsertSessionAnalyticsRollup`
 * exactly — same SELECT/aggregate/classification SQL — but scopes the outer
 * `sessions` scan and the inner aggregate sub-selects to `s.id IN (…)` (the
 * inner sub-selects already `GROUP BY session_id`, so restricting them to the
 * chunk just bounds the scan; the `JOIN`/`GROUP BY` then yield one rollup row
 * per session). Behavior-preserving: identical rollup rows/values, far fewer
 * commits.
 */
export async function upsertSessionAnalyticsRollupBatch(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  /* ISS-5098: `log` reaches `ensureStoredAgentComponentInvocations` below, which
     reports an agent reference the row writer had to drop. REQUIRED, not an
     optional field defaulted to a no-op: this is the ONLY caller of the legacy
     bootstrap, so an omittable `log` here re-opens one level up exactly the
     silent path wongk (#4355) asked us to close at the writer. Every call site
     already has a `log` in scope, so requiring it costs a threaded argument and
     buys a compile-time guarantee that no rollup commits a drop in silence. */
  options: SessionAnalyticsRollupOptions
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  // FEA-2430: `started_day` (session_analytics + session_tool_analytics) is a
  // stored UTC-day derivation — storage-only, zero readers. It must stay UTC:
  // a stored LOCAL day would go stale when the user changes timezone or DST
  // shifts, forcing full-table rebuilds. Any future DISPLAY read must re-bucket
  // from the raw timestamp with strftime(..., 'localtime') (see
  // local-insights.ts's timezone contract), never read this column.
  const dayExpr = (col: string) =>
    `CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(${col}, 1, 10) ELSE NULL END`;
  const t = SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD;
  // session_analytics upsert: $1 = now; the session ids occupy $2..$(N+1). The
  // IN list is repeated for the outer scan and each inner aggregate sub-select
  // so SQLite bounds every scan to the chunk; reusing the same numbered params
  // keeps a single bound array.
  const analyticsIdPlaceholders = sessionIds
    .map((_, i) => `$${i + 2}`)
    .join(", ");
  const analyticsParams: unknown[] = [now, ...sessionIds];
  // The tool-analytics DELETE + INSERT bind `sessionIds` alone, so their IN list
  // starts at $1 (no `now` param).
  const toolIdPlaceholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `INSERT OR REPLACE INTO session_analytics (
       session_id, started_at, started_day, status, harness,
       human_turns, agent_turns, is_human, event_count, tool_invocations, error_events,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost,
       runtime_ms, updated_at
     )
     SELECT
       s.id,
       s.started_at,
       ${dayExpr("s.started_at")},
       s.status,
       s.harness,
       COALESCE(s.transcript_human_turns, ht.human_turns, 0),
       COALESCE(s.transcript_assistant_turns, ev.agent_turns, 0),
       CASE
         WHEN ${headlessMetadataSql("s.metadata")} THEN 0
         WHEN COALESCE(s.transcript_human_turns, ht.human_turns, 0) >= ${t} THEN 1
         ELSE 0
       END,
       COALESCE(ev.event_count, 0),
       COALESCE(ev.tool_invocations, 0),
       COALESCE(ev.error_events, 0),
       COALESCE(tok.input_tokens, 0),
       COALESCE(tok.output_tokens, 0),
       COALESCE(tok.cache_read_tokens, 0),
       COALESCE(tok.cache_write_tokens, 0),
       -- PRD-538: est_cost is the session TOTAL, so it must include the
       -- per-request web-search line item — kept OUT of token_usage on purpose,
       -- so tok.est_cost alone undercounts every web-search session. Read the
       -- SAME single source updateSessionCostRollup prices (the persisted
       -- $.usageExtras.web_search_requests count) and add it exactly once here.
       -- No double-count: web-search cost never lives in a token_usage row, so
       -- tok.est_cost and this term are disjoint. json_extract returns NULL when
       -- the field is absent (no web search), coalescing to +0.
       --
       -- FEA-3419: the FEA-3636 session-level 1h TTL premium term is GONE — the
       -- premium is now baked into per-event and per-model costs by
       -- estimateTokenCost (cacheWrite1hTokens), so tok.est_cost already
       -- carries it; a rollup-level term would double-count.
       COALESCE(tok.est_cost, 0) + ${webSearchCostSql("s.metadata")},
       CASE
         WHEN s.started_at IS NOT NULL AND s.ended_at IS NOT NULL AND s.ended_at > s.started_at
           THEN CAST((unixepoch(s.ended_at, 'subsec') - unixepoch(s.started_at, 'subsec')) * 1000 AS INTEGER)
         ELSE NULL
       END,
       $1
     FROM (
       -- FEA-2641: genuine human turns are counted transcript-first — a
       -- role:"human" message count over metadata $.messages (NULL when no
       -- parsed transcript exists, e.g. hook-only live sessions). Computed
       -- once here so the human_turns column and the is_human CASE share it.
       -- Nested CASE so json_type never runs on invalid JSON; the inner CASE
       -- gates json_extract on m.type = 'object' (json_each's own type
       -- column) so a primitive array element (string/number/null) can never
       -- raise "malformed JSON" and abort the whole rollup chunk.
       SELECT s.*,
         CASE WHEN json_valid(s.metadata)
              THEN CASE WHEN json_type(s.metadata, '$.messages') = 'array'
                        THEN (SELECT COUNT(*)
                              FROM json_each(s.metadata, '$.messages') AS m
                              WHERE CASE WHEN m.type = 'object'
                                         THEN json_extract(m.value, '$.role') = 'human'
                                         ELSE 0 END)
                        ELSE NULL END
              ELSE NULL END AS transcript_human_turns,
         -- FEA-3226: assistant turns are counted transcript-first from the
         -- importer's top-level $.assistantMessages count (the parser's
         -- billable round-trip count, FEA-3125) — NEVER from the visible
         -- $.messages rows, which split one billable turn across text /
         -- tool_use blocks and would overcount. NULL when the blob lacks the
         -- field (hook-only live sessions), so the event-name heuristic below
         -- stays the fallback exactly as ht.human_turns does for human turns.
         --
         -- FEA-3597: FEA-3226 also asserted, as an unverified aside, that the
         -- session_turn_bucket store "counts assistant turns correctly from
         -- $.messages" and that THIS column was the stale one. That is
         -- BACKWARDS. This rollup is canonical; the bucket store was the
         -- inflated one, by ~3x on 663 of 1,181 sessions in a 14-day window,
         -- for exactly the per-block reason stated above. FEA-3597 moved the
         -- bucket store's agent rows onto the $.tokenSeries (the billable
         -- round-trip series) so the two stores now agree by construction
         -- rather than by coincidence. ISS-5395 narrows that agreement to
         -- NON-DELEGATING sessions: the bucket store now also counts a folded
         -- subagent's round-trips (they had no other timeline to land on),
         -- while THIS column stays the parent transcript's own assistant-turn
         -- count. On a delegating session the bucket total is legitimately the
         -- larger of the two.
         ${transcriptAssistantTurnsSql("s.metadata")} AS transcript_assistant_turns
       FROM sessions s
       WHERE s.id IN (${analyticsIdPlaceholders})
     ) s
     LEFT JOIN (
       SELECT session_id,
         COUNT(*) AS event_count,
         SUM(CASE WHEN ${toolInvocationPredicate("tool_name")} THEN 1 ELSE 0 END) AS tool_invocations,
         SUM(CASE WHEN lower(event_type) LIKE '%assistant%' THEN 1 ELSE 0 END) AS agent_turns,
         SUM(CASE WHEN (lower(event_type) LIKE '%error%' OR lower(event_type) LIKE '%fail%') THEN 1 ELSE 0 END) AS error_events
       FROM events WHERE session_id IN (${analyticsIdPlaceholders}) GROUP BY session_id
     ) ev ON ev.session_id = s.id
     LEFT JOIN (
       SELECT session_id, COUNT(*) AS human_turns
       FROM events
       WHERE session_id IN (${analyticsIdPlaceholders})
         AND (lower(event_type) LIKE '%user%' OR lower(event_type) LIKE '%prompt%')
       GROUP BY session_id
     ) ht ON ht.session_id = s.id
     LEFT JOIN (
       SELECT session_id,
         -- FEA-2879: sum the EFFECTIVE totals (current + pre-compaction
         -- baseline_*) so the materialized session_analytics token counts don't
         -- drop to the post-compaction subset. est_cost sums the per-row
         -- cost_usd_estimated, which is already priced on the effective total.
         SUM(COALESCE(input_tokens, 0) + COALESCE(baseline_input, 0)) AS input_tokens,
         SUM(COALESCE(output_tokens, 0) + COALESCE(baseline_output, 0)) AS output_tokens,
         SUM(COALESCE(cache_read_tokens, 0) + COALESCE(baseline_cache_read, 0)) AS cache_read_tokens,
         SUM(COALESCE(cache_write_tokens, 0) + COALESCE(baseline_cache_write, 0)) AS cache_write_tokens,
         SUM(COALESCE(cost_usd_estimated, 0)) AS est_cost
       FROM token_usage WHERE session_id IN (${analyticsIdPlaceholders}) GROUP BY session_id
     ) tok ON tok.session_id = s.id`,
    ...analyticsParams
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM session_tool_analytics WHERE session_id IN (${toolIdPlaceholders})`,
    ...sessionIds
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO session_tool_analytics (session_id, tool_name, invocations, started_day)
     SELECT e.session_id, e.tool_name, COUNT(*),
       (SELECT ${dayExpr("s.started_at")} FROM sessions s WHERE s.id = e.session_id)
     FROM events e
     WHERE e.session_id IN (${toolIdPlaceholders}) AND ${toolInvocationPredicate("e.tool_name")}
     GROUP BY e.session_id, e.tool_name`,
    ...sessionIds
  );
  // FEA-3294: invocation materialization is the durable source of truth. A
  // legacy stored-only session is conservatively bootstrapped from its existing
  // event/agent/metadata rows (never the current filesystem), then the aggregate
  // is replaced from invocation rows only. The isolated importer explicitly
  // disables this replacement when its invocation phase failed.
  if (options.replaceComponentUsage !== false) {
    await ensureStoredAgentComponentInvocations(
      tx,
      sessionIds,
      now,
      options.log
    );
    await rebuildAgentComponentSessionUsageFromInvocations(
      tx,
      sessionIds,
      dayExpr
    );
  }
  // FEA-3132: materialize per-turn buckets so the Insights autonomy trend +
  // activity heatmap never json_each-expand `$.messages` on the read path.
  await rebuildSessionTurnBuckets(tx, sessionIds);
}

/**
 * ISS-5098 (wongk, #4355): the rollup's options bag, now REQUIRED because `log`
 * is. The rollup is the only caller of `ensureStoredAgentComponentInvocations`,
 * which builds invocation candidates from `events.agent_id` — a column with no
 * foreign key — so it is one of the two paths that can hand the row writer an
 * agent reference no `agents` row satisfies. The writer nulls that reference
 * rather than let it abort the whole insert, and reports the drop through this
 * `log`; making the bag required is what stops a caller from routing an
 * unreportable drop through here and committing it in silence.
 */
export type SessionAnalyticsRollupOptions = {
  /** FEA-3294: the isolated importer sets this false when its invocation phase
   *  failed, so the aggregate is not replaced from a partial invocation set. */
  replaceComponentUsage?: boolean;
  log: (message: string) => void;
};
