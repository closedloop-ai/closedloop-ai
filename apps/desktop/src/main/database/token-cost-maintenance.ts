/**
 * @file token-cost-maintenance.ts
 * @description Boot-only token-cost maintenance passes extracted from
 * write-core.ts (ISS-4852): the token-usage repricing pass plus the
 * cost-conservation / cache-cost-split / TTL-premium / last-activity-floor /
 * swept-session heals. Every function here runs EXCLUSIVELY from the sqlite.ts
 * boot orchestrator (never on the live-hook or import hot path), so it lives in
 * its own module to keep write-core.ts focused on ingest. Depends
 * one-directionally on ./token-cost-writes.js (ISS-4936) for the token-cost /
 * conservation primitives (updateTokenUsageCost, updateTokenEventCost,
 * updateSessionCostRollup, chooseConservedUsageCost, webSearchCostSql, …) and on
 * ./session-analytics-rollup.js for the analytics-rollup primitives
 * (upsertSessionAnalyticsRollupBatch, chunkSessionIdsByMetadataBudget, …) and on
 * ./write-core.js for the session helpers (recomputeSessionLastActivityAt, …);
 * none of the three imports this file, so there is no import cycle.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  type TokenCostSummary,
} from "@repo/api/src/types/token-cost-provenance";
import { estimateTokenCost } from "../../shared/token-cost.js";
import {
  ModelPricingCurrency,
  ModelPricingSource,
} from "../model-pricing/model-pricing-fixture.js";
import { tokenCountValue } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  SESSION_ANALYTICS_BACKFILL_CHUNK,
  upsertSessionAnalyticsRollupBatch,
} from "./session-analytics-rollup.js";
import {
  bumpSessionsUpdatedAt,
  chunkWatermark,
} from "./session-sync-watermark.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  ISO_DATE_PREFIX_GLOB_SQL,
  SESSION_CANONICAL_LAST_ACTIVITY_AT_SQL,
  SESSION_STARTED_AT_FLOOR_SQL,
} from "./session-timestamp-form.js";
import {
  chooseConservedUsageCost,
  conservationSumsFromRow,
  TOKEN_COST_CONSERVATION_RELATIVE_EPS,
  TOKEN_EVENT_CONSERVATION_SUMS_SUBQUERY,
  type TokenEventConservationSumRow,
  type TokenEventConservationSums,
  tokenCostsConserved,
  updateSessionCostRollup,
  updateTokenEventCost,
  updateTokenUsageCost,
  webSearchCostSql,
} from "./token-cost-writes.js";
import {
  isLocallyDerivedStoredTokenCostSummary,
  parseStoredTokenCostSummary,
  parseStoredTokenSourceIdentity,
  type TokenEventRecord,
} from "./token-event-contract.js";
import {
  TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER,
  tokenUsageEventParitySourceFilter,
} from "./token-parity.js";
import { recomputeSessionLastActivityAt } from "./write-core.js";

/**
 * COST_ATTRIBUTION_DRIFT: boot-time pass that re-prices `token_usage` rows to the
 * CURRENT `estimateTokenCost` of their EFFECTIVE total. Two row populations are
 * healed here:
 *
 *  1. `cost_usd_estimated IS NULL` — rows whose `model` was not priceable when
 *     first imported (e.g. a model that `genai-prices` did not yet know). A later
 *     app version that ships an updated pricing table can now price them.
 *  2. FEA-2879 repair: already-costed COMPACTED rows (`baseline_* > 0` AND
 *     `cost_usd_estimated IS NOT NULL`). A row compacted BEFORE the FEA-2879 patch
 *     had its cost computed by the old current-only pricing path, which ignored
 *     the pre-compaction totals rolled into `baseline_*`, so it undercounts. Since
 *     this PR does not bump `DATA_REVISION`, those rows are never re-imported and
 *     would keep their stale cost indefinitely without this repair.
 *
 * Most cost surfaces (session list/detail, cloud sync, artifact usage) re-derive
 * such rows on every read via `resolveTokenUsageCostUsd`, but the MATERIALIZED
 * snapshots — `session_analytics.est_cost` (the dashboard "Cost" KPI) and
 * `sessions.cost_usd_estimated` (the session-list authoritative cost) — were
 * frozen at the value the row contributed at rollup time (the `$0` a NULL row
 * contributes, or the undercounted current-only cost of a pre-patch compacted
 * row). So both populations leave those snapshots undercounting versus the
 * re-pricing read surfaces.
 *
 * This pass re-prices each affected row with the CURRENT `estimateTokenCost` of
 * the effective total (`current + baseline_*`), persists the newly-resolved cost
 * (mirroring the ingest path's `updateTokenUsageCost`), then rebuilds both
 * snapshots for the affected sessions (`updateSessionCostRollup` +
 * `upsertSessionAnalyticsRollupBatch`) so every surface agrees again.
 *
 * Idempotent / convergent: cost is recomputed from the effective total (never
 * added onto the stored value), and `baseline_*` is read-only here, so re-running
 * yields the identical cost — no double-count. A still-unpriceable NULL row stays
 * NULL and is skipped. An already-correct compacted row (stored cost already ==
 * the effective-total price) is left untouched, so once repaired it is never
 * rewritten and the pass converges. Chunked per session set like
 * `backfillSessionAnalytics`; a failed chunk is logged and skipped, and remaining
 * chunks still run.
 *
 * Scope: `token_usage` only. The sibling `token_events` table also stores a NULL
 * cost for unpriceable rows, but no surface reads its frozen `cost_usd_estimated`
 * as a materialized value (every token_events cost surface re-derives on read),
 * so there is no snapshot to heal there.
 */
export async function repriceUnpricedTokenUsage(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  // Distinct sessions with at least one row that needs (re-)pricing: an unpriced
  // row (population 1) OR an already-costed compacted row whose stored cost may
  // predate the FEA-2879 effective-total pricing (population 2). Raw read on the
  // one client; the chunk pass filters precisely + skips already-correct rows.
  const unpriced = await prisma.client.$queryRawUnsafe<
    { session_id: string }[]
  >(
    `SELECT DISTINCT session_id FROM token_usage
      WHERE cost_usd_estimated IS NULL
         OR baseline_input > 0
         OR baseline_output > 0
         OR baseline_cache_read > 0
         OR baseline_cache_write > 0`
  );
  if (unpriced.length === 0) {
    return;
  }
  const ids = unpriced.map((row) => row.session_id);
  const now = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let repricedRows = 0;
  let repricedSessions = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    // FEA-3485: per-chunk watermark (see `chunkWatermark`) so a repair spanning
    // many chunks (e.g. a popular model becomes priceable) does not collapse the
    // whole repriced set onto one sync-cursor top timestamp.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      const result = await prisma.write((client) =>
        client.$transaction((tx) =>
          repriceUnpricedTokenUsageChunk(tx, chunk, chunkNow, log)
        )
      );
      repricedRows += result.repricedRows;
      repricedSessions += result.repricedSessions;
    } catch (error) {
      log(
        `token-usage re-pricing failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(
    `token-usage re-pricing complete: repriced ${repricedRows} row(s) across ${repricedSessions} session(s)`
  );
}

/**
 * Re-price one chunk of sessions in a single transaction, persist the
 * newly-resolved costs, and rebuild both cost snapshots for the sessions that
 * actually changed. Returns counts for the caller's completion log.
 *
 * Selects the two populations `repriceUnpricedTokenUsage` documents: unpriced
 * rows (`cost_usd_estimated IS NULL`) and already-costed compacted rows
 * (`baseline_* > 0`). For each, prices the EFFECTIVE total (current +
 * pre-compaction `baseline_*`):
 *  - a row that is still unpriceable is left NULL and silently skipped (it was
 *    already reported as a pricing miss at ingest, so re-reporting it every boot
 *    would only add noise);
 *  - a row whose freshly-computed effective cost already equals the stored value
 *    is left untouched — this makes the FEA-2879 compacted-row repair convergent:
 *    once repriced, it never rewrites again.
 */
async function repriceUnpricedTokenUsageChunk(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  log: (message: string) => void
): Promise<{ repricedRows: number; repricedSessions: number }> {
  if (sessionIds.length === 0) {
    return { repricedRows: 0, repricedSessions: 0 };
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await tx.$queryRawUnsafe<
    {
      session_id: string;
      model: string;
      input_tokens: unknown;
      output_tokens: unknown;
      cache_read_tokens: unknown;
      cache_write_tokens: unknown;
      cache_write_5m_tokens: unknown;
      cache_write_1h_tokens: unknown;
      created_at: string | null;
      cost_usd_estimated: number | null;
      parity_eligible: unknown;
    }[]
  >(
    // FEA-2879: reprice the EFFECTIVE total (current + pre-compaction
    // baseline_*) so a compacted session's healed cost reflects all incurred
    // tokens, not just the post-compaction subset. Mirrors
    // selectTokenUsagePricingRows; aliases keep the row shape unchanged. Selects
    // BOTH unpriced rows and already-costed compacted rows (baseline_* > 0) so
    // pre-FEA-2879 compacted rows priced under the old current-only path are
    // repaired; `cost_usd_estimated` is read back to skip already-correct rows.
    // FEA-3419: TTL columns ride along (current-only, never baseline-folded) so
    // a later-boot reprice preserves the one-hour premium instead of silently
    // stripping it back to the five-minute rate.
    `SELECT session_id, model,
            input_tokens + baseline_input AS input_tokens,
            output_tokens + baseline_output AS output_tokens,
            cache_read_tokens + baseline_cache_read AS cache_read_tokens,
            cache_write_tokens + baseline_cache_write AS cache_write_tokens,
            cache_write_5m_tokens,
            cache_write_1h_tokens,
            created_at,
            cost_usd_estimated,
            (${TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER}) AS parity_eligible
       FROM token_usage
      WHERE (
              cost_usd_estimated IS NULL
              OR baseline_input > 0
              OR baseline_output > 0
              OR baseline_cache_read > 0
              OR baseline_cache_write > 0
            )
        AND session_id IN (${placeholders})`,
    ...sessionIds
  );
  // FEA-3232 (review): a pricing-table upgrade that makes a model priceable
  // must reprice the model's EVENT rows too. Import left them NULL alongside
  // the usage row; pricing only the aggregate would leave the conservation
  // predicate fail-closed (unpriced events) forever, so never-re-imported
  // tiered sessions would keep the lifetime-aggregate tier overcharge this
  // pass exists to remove. Rows whose model still doesn't price stay NULL and
  // are revisited next boot, same as the usage rows below.
  if (rows.length > 0) {
    const repricedSessionIds = [...new Set(rows.map((row) => row.session_id))];
    const eventPlaceholders = repricedSessionIds
      .map((_, i) => `$${i + 1}`)
      .join(", ");
    const unpricedEvents = await tx.$queryRawUnsafe<
      {
        session_id: string;
        transport_id: string | null;
        model: string;
        created_at: string;
        input_tokens: unknown;
        output_tokens: unknown;
        cache_read_tokens: unknown;
        cache_write_tokens: unknown;
        cache_write_5m_tokens: unknown;
        cache_write_1h_tokens: unknown;
        source_identity: unknown;
        cost_summary: unknown;
      }[]
    >(
      `SELECT session_id, transport_id, model, created_at, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              cache_write_5m_tokens, cache_write_1h_tokens,
              source_identity, cost_summary
         FROM token_events
        WHERE cost_usd_estimated IS NULL
          AND session_id IN (${eventPlaceholders})`,
      ...repricedSessionIds
    );
    for (const eventRow of unpricedEvents) {
      const record: TokenEventRecord = {
        timestamp: eventRow.created_at,
        model: eventRow.model,
        input: tokenCountValue(eventRow.input_tokens, "reprice.event.input"),
        output: tokenCountValue(eventRow.output_tokens, "reprice.event.output"),
        cacheRead: tokenCountValue(
          eventRow.cache_read_tokens,
          "reprice.event.cache_read"
        ),
        cacheWrite: tokenCountValue(
          eventRow.cache_write_tokens,
          "reprice.event.cache_write"
        ),
        ...(eventRow.transport_id === null
          ? {}
          : { transportId: eventRow.transport_id }),
        ...storedSourceIdentity(eventRow.source_identity),
        ...producerCostSummary(eventRow.cost_summary),
        // FEA-3419: carry the persisted split so the reprice prices 1h at 2x
        // AND the updateTokenEventCost locator (null-safe TTL pair) matches.
        ...(eventRow.cache_write_1h_tokens == null
          ? {}
          : {
              cacheWriteTtl: {
                fiveM: tokenCountValue(
                  eventRow.cache_write_5m_tokens,
                  "reprice.event.cache_write_5m"
                ),
                oneH: tokenCountValue(
                  eventRow.cache_write_1h_tokens,
                  "reprice.event.cache_write_1h"
                ),
              },
            }),
      };
      const estimate = estimateTokenCost({
        model: record.model,
        inputTokens: record.input,
        outputTokens: record.output,
        cacheReadTokens: record.cacheRead,
        cacheWriteTokens: record.cacheWrite,
        ...(record.cacheWriteTtl
          ? { cacheWrite1hTokens: record.cacheWriteTtl.oneH }
          : {}),
        observedAt: record.timestamp,
      });
      if (!estimate) {
        continue;
      }
      await updateTokenEventCost(
        tx,
        eventRow.session_id,
        record,
        estimate,
        record.timestamp
      );
    }
  }
  // FEA-3232: the freshly repriced value must obey the same conservation rule
  // as the import path, or a boot reprice of a tiered-model row would
  // reintroduce the aggregate-tier overpricing the conservation heal removes.
  const eventSums =
    rows.length > 0
      ? await selectTokenEventConservationSumsBySession(tx, [
          ...new Set(rows.map((row) => row.session_id)),
        ])
      : new Map<string, TokenEventConservationSums>();
  const affected = new Set<string>();
  let repricedRows = 0;
  for (const row of rows) {
    const observedAt = row.created_at ?? now;
    // FEA-3419: current-only TTL columns; NULL = never reported.
    const usageTtl = {
      fiveM:
        row.cache_write_5m_tokens == null
          ? null
          : tokenCountValue(
              row.cache_write_5m_tokens,
              "reprice.cache_write_5m"
            ),
      oneH:
        row.cache_write_1h_tokens == null
          ? null
          : tokenCountValue(
              row.cache_write_1h_tokens,
              "reprice.cache_write_1h"
            ),
    };
    const costInput = {
      model: row.model,
      inputTokens: tokenCountValue(row.input_tokens, "reprice.input"),
      outputTokens: tokenCountValue(row.output_tokens, "reprice.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "reprice.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "reprice.cache_write"
      ),
      ...(usageTtl.oneH === null ? {} : { cacheWrite1hTokens: usageTtl.oneH }),
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      // Still unpriceable with the current table — leave NULL, revisit next boot.
      continue;
    }
    const conserved = chooseConservedUsageCost(
      estimate,
      costInput,
      Number(row.parity_eligible) === 1,
      eventSums.get(conservationSumKey(row.session_id, row.model)),
      usageTtl
    );
    // Convergence guard: an already-costed row whose stored cost already
    // matches the FINAL (post-conservation) value needs no rewrite. Comparing
    // against the conserved value — not the aggregate estimate — keeps rows
    // that conserved to Σ(event prices) zero-write on every subsequent boot.
    const storedCost =
      row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated);
    if (storedCost !== null && storedCost === conserved.costUsd) {
      continue;
    }
    await updateTokenUsageCost(
      tx,
      row.session_id,
      row.model,
      conserved,
      observedAt
    );
    affected.add(row.session_id);
    repricedRows += 1;
  }
  const repricedSessions = [...affected];
  if (repricedSessions.length > 0) {
    // Heal the per-session snapshot (`sessions.cost_usd_estimated`) and the
    // analytics rollup (`session_analytics.est_cost`) the same way the ingest
    // path does once token_usage costs change.
    // FEA-3488: batch the cost-snapshot rollup in ONE GROUP BY aggregate + one
    // UPDATE (was a per-session N+1 of 2 serial queries each), mirroring the
    // batched `upsertSessionAnalyticsRollupBatch` called on the next line.
    await updateSessionCostRollupBatch(tx, repricedSessions);
    await upsertSessionAnalyticsRollupBatch(tx, repricedSessions, now, { log });
    // SYNC INVARIANT: both rebuilt snapshots sync to the cloud as-is
    // (`session_analytics.est_cost` → `estimatedCostUsd`, and
    // `sessions.cost_usd_estimated`), so advance the sync watermark for the
    // repriced sessions — an install that already uploaded the stale cost would
    // otherwise keep it in the cloud dashboard until an unrelated mutation
    // touched the session. Convergent: a correctly-priced row hits the equality
    // guard above and drops out of `affected`, so once repaired a session is
    // never re-bumped.
    await bumpSessionsUpdatedAt(tx, repricedSessions, now);
  }
  return { repricedRows, repricedSessions: repricedSessions.length };
}

/** Preserve producer-authored summaries while allowing local legacy estimates to reprice. */
function producerCostSummary(
  value: unknown
): { costSummary: TokenCostSummary } | Record<string, never> {
  const summary = parseStoredTokenCostSummary(value);
  if (
    summary === undefined ||
    isLocallyDerivedStoredTokenCostSummary(value) ||
    isCanonicalLocalPartialSummary(summary)
  ) {
    return {};
  }
  return { costSummary: summary };
}

/** Recognize pre-marker local API estimates without treating unavailable as local. */
function isCanonicalLocalPartialSummary(summary: TokenCostSummary): boolean {
  return (
    summary.completeness === TokenCostCompleteness.Partial &&
    (summary.reason === TokenCostCompletenessReason.LegacyRecord ||
      summary.reason ===
        TokenCostCompletenessReason.SourceIdentityUnavailable) &&
    summary.lanes?.length === 1 &&
    summary.lanes[0]?.basis === TokenCostBasis.ApiEstimated &&
    summary.lanes[0].subtotalUsd === summary.subtotalUsd
  );
}

/** Carry stored identity so locally-derived unavailable cost can reprice truthfully. */
function storedSourceIdentity(
  value: unknown
): Pick<TokenEventRecord, "sourceIdentity"> | Record<string, never> {
  const sourceIdentity = parseStoredTokenSourceIdentity(value);
  return sourceIdentity === undefined ? {} : { sourceIdentity };
}

/**
 * FEA-2344: boot-time pass that re-splits the cache cost components of
 * `token_events` rows whose `cache_creation_cost_usd_estimated` is NULL and that
 * have cache tokens. Pre-fix writes folded all cache cost into `input_cost`, so
 * the cache columns are ~$0 and `cache_creation` is hardcoded NULL. This pass
 * recomputes the split with the fixed `estimateTokenCost` and updates ONLY the
 * component columns — `cost_usd_estimated` totals are already correct and are
 * never touched. Idempotent: post-fix writes always store a number in
 * `cache_creation`, so the NULL filter converges and healed rows are never
 * revisited. Chunked per session; a failed chunk is logged and skipped.
 */
/**
 * FEA-3419: converge session cost rollups after the FEA-3636 session-level 1h
 * TTL premium term was REMOVED from the rollup formula (the premium now lives
 * inside per-event / per-model costs via estimateTokenCost).
 *
 * Candidates: sessions whose persisted metadata still carries the retired
 * `usageExtras.cache_creation` blob with a non-zero 1h count — exactly the rows
 * the old SQL premium term inflated. Their stored `sessions.cost_usd_estimated`
 * / `session_analytics.est_cost` still embed that premium until something
 * recomputes them; for sessions whose raw transcript is retained the
 * DATA_REVISION 31 rebuild does it (and re-derives the typed split for exact
 * 2x pricing), but UNRETAINED sessions would keep the stale total forever.
 * This heal recomputes their rollups from scratch (pure Σ token_usage +
 * web search) and bumps the sync watermark for rows whose cost actually
 * changed, so the corrected totals re-sync to the cloud (ISO watermark rule).
 *
 * Deliberate consequence (plan ruling, approved): unretained rev-24..30
 * sessions with 1h writes LOSE the premium and fall back to default-rate
 * pricing with absent provenance — the blob's session-level sum cannot be
 * honestly attributed per event, and fabricating a split would both violate
 * provenance and be reconciled away by conservation anyway. The affected count
 * is logged. Convergent: once recomputed, costs match and no watermark bumps
 * fire; reparsed sessions drop out of the candidate set when their metadata is
 * rewritten without the blob.
 */
export async function healSessionRollupAfterTtlPremiumRemoval(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const candidates = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `WITH candidate_costs AS (
       SELECT
         s.id AS id,
         s.cost_usd_estimated AS stored_cost_usd,
         CASE
           WHEN COALESCE(tok.priced_rows, 0) > 0
             OR ${webSearchCostSql("s.metadata")} > 0
             THEN COALESCE(tok.token_cost_usd, 0) + ${webSearchCostSql("s.metadata")}
           ELSE NULL
         END AS recomputed_cost_usd
       FROM sessions s
       LEFT JOIN (
         SELECT
           session_id,
           COALESCE(SUM(cost_usd_estimated), 0) AS token_cost_usd,
           COUNT(cost_usd_estimated) AS priced_rows
         FROM token_usage
         GROUP BY session_id
       ) tok ON tok.session_id = s.id
       WHERE s.cost_usd_estimated IS NOT NULL
         AND json_valid(s.metadata)
         AND CAST(COALESCE(json_extract(s.metadata, '$.usageExtras.cache_creation.ephemeral_1h_input_tokens'), 0) AS REAL) > 0
     )
     SELECT id FROM candidate_costs
     WHERE recomputed_cost_usd IS NULL
        OR ABS(recomputed_cost_usd - stored_cost_usd) >
           ${TOKEN_COST_CONSERVATION_RELATIVE_EPS} *
           MAX(1, ABS(recomputed_cost_usd), ABS(stored_cost_usd))`
  );
  if (candidates.length === 0) {
    return;
  }
  const ids = candidates.map((row) => row.id);
  const now = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healedSessions = 0;
  let failedChunks = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    // FEA-3485: per-chunk watermark so a multi-chunk heal does not collapse the
    // whole healed set onto one sync-cursor top timestamp.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      const changed = await prisma.write((client) =>
        client.$transaction((tx) =>
          healSessionRollupAfterTtlPremiumRemovalChunk(tx, chunk, chunkNow, log)
        )
      );
      healedSessions += changed;
    } catch (error) {
      failedChunks += 1;
      log(
        `ttl-premium-removal rollup heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (healedSessions > 0 || failedChunks > 0) {
    log(
      `ttl-premium-removal rollup heal: recomputed ${healedSessions} session(s) of ${ids.length} candidate(s)` +
        (failedChunks > 0 ? ` (${failedChunks} chunk(s) failed)` : "")
    );
  }
}

async function healSessionRollupAfterTtlPremiumRemovalChunk(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  log: (message: string) => void
): Promise<number> {
  if (sessionIds.length === 0) {
    return 0;
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const readCosts = async (): Promise<Map<string, number | null>> => {
    const rows = await tx.$queryRawUnsafe<
      { id: string; cost_usd_estimated: number | null }[]
    >(
      `SELECT id, cost_usd_estimated FROM sessions WHERE id IN (${placeholders})`,
      ...sessionIds
    );
    return new Map(rows.map((row) => [row.id, row.cost_usd_estimated]));
  };
  const before = await readCosts();
  await updateSessionCostRollupBatch(tx, sessionIds);
  await upsertSessionAnalyticsRollupBatch(tx, sessionIds, now, { log });
  const after = await readCosts();
  const changed = sessionIds.filter((id) => {
    const a = before.get(id) ?? null;
    const b = after.get(id) ?? null;
    return a === null ? b !== null : b === null || !tokenCostsConserved(a, b);
  });
  if (changed.length > 0) {
    // ISO parameterized watermark — visible to the raw-string sync cursor.
    await bumpSessionsUpdatedAt(tx, changed, now);
  }
  return changed.length;
}

export async function healCacheCostSplit(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const unhealed = await prisma.client.$queryRawUnsafe<
    { session_id: string }[]
  >(
    `SELECT DISTINCT session_id FROM token_events
     WHERE cost_usd_estimated IS NOT NULL
       AND (cache_read_tokens > 0 OR cache_write_tokens > 0)
       AND cache_creation_cost_usd_estimated IS NULL`
  );
  if (unhealed.length === 0) {
    return;
  }
  const ids = unhealed.map((row) => row.session_id);
  const now = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healedRows = 0;
  let healedSessions = 0;
  let failedChunks = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    // FEA-3485: per-chunk watermark (see `chunkWatermark`) so a multi-chunk heal
    // does not collapse the whole healed set onto one sync-cursor top timestamp.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      const count = await prisma.write((client) =>
        client.$transaction((tx) =>
          healCacheCostSplitChunk(tx, chunk, chunkNow, log)
        )
      );
      healedRows += count;
      if (count > 0) {
        healedSessions += chunk.length;
      }
    } catch (error) {
      failedChunks += 1;
      log(
        `cache-cost-split heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (healedRows > 0 || failedChunks > 0) {
    log(
      `cache-cost-split heal: re-split ${healedRows} row(s) across ${healedSessions} session(s)` +
        (failedChunks > 0 ? ` (${failedChunks} chunk(s) failed)` : "")
    );
  }
}

async function healCacheCostSplitChunk(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  log: (message: string) => void
): Promise<number> {
  if (sessionIds.length === 0) {
    return 0;
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await tx.$queryRawUnsafe<
    {
      session_id: string;
      model: string;
      created_at: string;
      input_tokens: unknown;
      output_tokens: unknown;
      cache_read_tokens: unknown;
      cache_write_tokens: unknown;
      cache_write_5m_tokens: unknown;
      cache_write_1h_tokens: unknown;
    }[]
  >(
    `SELECT session_id, model, created_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens
       FROM token_events
      WHERE cost_usd_estimated IS NOT NULL
        AND (cache_read_tokens > 0 OR cache_write_tokens > 0)
        AND cache_creation_cost_usd_estimated IS NULL
        AND session_id IN (${placeholders})`,
    ...sessionIds
  );
  let healed = 0;
  const affected = new Set<string>();
  for (const row of rows) {
    const inputTokens = tokenCountValue(row.input_tokens, "heal.input");
    const outputTokens = tokenCountValue(row.output_tokens, "heal.output");
    const cacheReadTokens = tokenCountValue(
      row.cache_read_tokens,
      "heal.cache_read"
    );
    const cacheWriteTokens = tokenCountValue(
      row.cache_write_tokens,
      "heal.cache_write"
    );
    // FEA-3419: carry the persisted split (legacy rows are NULL = absent) so the
    // healed cache-write lane prices 1h at 2x and the locator matches null-safe.
    const oneHourTokens =
      row.cache_write_1h_tokens == null
        ? null
        : tokenCountValue(row.cache_write_1h_tokens, "heal.cache_write_1h");
    const fiveMinuteTokens =
      row.cache_write_5m_tokens == null
        ? null
        : tokenCountValue(row.cache_write_5m_tokens, "heal.cache_write_5m");
    const estimate = estimateTokenCost({
      model: row.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(oneHourTokens === null ? {} : { cacheWrite1hTokens: oneHourTokens }),
      observedAt: row.created_at,
    });
    if (!estimate) {
      continue;
    }
    await tx.$executeRawUnsafe(
      `UPDATE token_events SET
         input_cost_usd_estimated = $1,
         cache_read_cost_usd_estimated = $2,
         cache_creation_cost_usd_estimated = $3
       WHERE session_id = $4
         AND model = $5
         AND created_at = $6
         AND input_tokens = $7
         AND output_tokens = $8
         AND cache_read_tokens = $9
         AND cache_write_tokens = $10
         AND cache_write_5m_tokens IS $11
         AND cache_write_1h_tokens IS $12`,
      estimate.inputCostUsd,
      estimate.cacheReadCostUsd,
      estimate.cacheWriteCostUsd,
      row.session_id,
      row.model,
      row.created_at,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      fiveMinuteTokens,
      oneHourTokens
    );
    affected.add(row.session_id);
    healed += 1;
  }
  if (affected.size > 0) {
    await upsertSessionAnalyticsRollupBatch(tx, [...affected], now, { log });
    await bumpSessionsUpdatedAt(tx, [...affected], now);
  }
  return healed;
}

/**
 * FEA-3232: boot-time pass that conserves `token_usage.cost_usd_estimated` to
 * the sum of the row's per-request `token_events` prices. Pre-fix imports
 * priced the per-model rollup with ONE aggregate calcPrice call, which lands
 * tiered models (gpt-5.4, claude-sonnet-4-5/4-6, claude-opus-4-6, …) in the
 * long-context tier for the whole session even when no individual request
 * crossed it — the published tier is a per-REQUEST property. Qualifying rows
 * (every event priced, per-bucket count sums equal to the effective
 * current+baseline counts, OTel-only rows excluded — the same fail-closed
 * predicate as `chooseConservedUsageCost`) are set to Σ(event cost) and both
 * cost snapshots re-derived; `sessions.updated_at` is bumped in ISO form so
 * the sync cursor re-pushes the corrected costs. Idempotent: a healed row
 * conserves within the relative epsilon, so the predicate stops matching it.
 * Chunked per session; a failed chunk is logged and skipped.
 */
export async function healTokenUsageEventConservation(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  const divergent = await prisma.client.$queryRawUnsafe<
    { session_id: string }[]
  >(
    `SELECT DISTINCT u.session_id
       FROM token_usage u
       JOIN (${TOKEN_EVENT_CONSERVATION_SUMS_SUBQUERY}) e
         ON e.session_id = u.session_id AND e.model = u.model
      WHERE ${tokenUsageEventParitySourceFilter("u")}
        AND ${TOKEN_USAGE_EVENT_CONSERVATION_QUALIFIES}`
  );
  if (divergent.length === 0) {
    return;
  }
  const ids = divergent.map((row) => row.session_id);
  const now = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healedRows = 0;
  let healedSessions = 0;
  let failedChunks = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    // FEA-3485: per-chunk watermark (see `chunkWatermark`) so a multi-chunk heal
    // does not collapse the whole conserved set onto one sync-cursor top timestamp.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      const result = await prisma.write((client) =>
        client.$transaction((tx) =>
          healTokenUsageEventConservationChunk(tx, chunk, chunkNow, log)
        )
      );
      healedRows += result.healedRows;
      healedSessions += result.healedSessions;
    } catch (error) {
      failedChunks += 1;
      log(
        `token-usage cost-conservation heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (healedRows > 0 || failedChunks > 0) {
    log(
      `token-usage cost-conservation heal: conserved ${healedRows} row(s) across ${healedSessions} session(s)` +
        (failedChunks > 0 ? ` (${failedChunks} chunk(s) failed)` : "")
    );
  }
}

async function healTokenUsageEventConservationChunk(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string,
  log: (message: string) => void
): Promise<{ healedRows: number; healedSessions: number }> {
  if (sessionIds.length === 0) {
    return { healedRows: 0, healedSessions: 0 };
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await tx.$queryRawUnsafe<
    { session_id: string; model: string; event_cost: number }[]
  >(
    `SELECT u.session_id, u.model, e.cost AS event_cost
       FROM token_usage u
       JOIN (${TOKEN_EVENT_CONSERVATION_SUMS_SUBQUERY}) e
         ON e.session_id = u.session_id AND e.model = u.model
      WHERE ${tokenUsageEventParitySourceFilter("u")}
        AND ${TOKEN_USAGE_EVENT_CONSERVATION_QUALIFIES}
        AND u.session_id IN (${placeholders})`,
    ...sessionIds
  );
  const affected = new Set<string>();
  for (const row of rows) {
    await tx.$executeRawUnsafe(
      `UPDATE token_usage SET
         cost_usd_estimated = $1,
         cost_observed_at = $2
       WHERE session_id = $3 AND model = $4`,
      Number(row.event_cost),
      now,
      row.session_id,
      row.model
    );
    affected.add(row.session_id);
  }
  const healedSessions = [...affected];
  if (healedSessions.length > 0) {
    for (const sessionId of healedSessions) {
      await updateSessionCostRollup(tx, sessionId);
    }
    await upsertSessionAnalyticsRollupBatch(tx, healedSessions, now, { log });
    await bumpSessionsUpdatedAt(tx, healedSessions, now);
  }
  return { healedRows: rows.length, healedSessions: healedSessions.length };
}

/**
 * FEA-3591: convergent boot heal for rows whose stored `last_activity_at`
 * disagrees with what {@link recomputeSessionLastActivityAt} derives from the
 * session's own STORED rows — originally only the rows violating the
 * `last_activity_at >= started_at` invariant the floor above enforces at write
 * time. The DATA_REVISION 30 rebuild only re-invokes the recompute for sessions
 * whose source transcript still exists on disk — missing-source sessions keep
 * their stale value forever (the rebuild's missing-source pass recomputes
 * analytics rollups only). This heal repairs the tail the rebuild structurally
 * cannot reach, and runs AWAITED before both boot sweeps because both consume
 * the stored value: `sweepOrphanedSessions` copies it into `ended_at`, and
 * `sweepExpiredSessions` purges on it — a pre-start value makes a row look hours
 * older than it is (premature purge eligibility).
 *
 * ISS-5497 (review) widened discovery from that ONE disagreement to ALL of them,
 * because the boot ORDERING makes the difference irreversible. The revision-75
 * rebuild that re-derives `last_activity_at` runs from POST-BOOT maintenance —
 * after `openSqliteAgentDatabase` has already run the retention sweep on the OLD
 * value. A wrong old winner can sit before the retention cutoff while the true
 * instant sits after it, so on the upgrade boot the purge would delete that
 * session and every child row before the rebuild could repair it; and a
 * missing-source session is stamped the new revision by the rollup bridge
 * without the recompute running at all. Being source-independent and running
 * HERE, this heal closes both FOR CANONICAL-MODE ROWS: such a session's cursor
 * is corrected from its own stored events — no transcript on disk required, no
 * `data_revision` gate — before either boot sweep consumes it. `failedChunks`
 * already blocks both sweeps for the boot (the wiring is in sqlite.ts), so a
 * partial heal can never be followed by a purge over half-corrected values.
 *
 * LEGACY-MODE ROWS ARE DELIBERATELY NOT CORRECTED, and that hole is stated here
 * rather than papered over. The ISS-5497 arm declines them by construction: the
 * canonical fold is NULL when any operand cannot be canonicalized, so
 * `COALESCE(NULL, last_activity_at) IS NOT last_activity_at` is false and the
 * row is never discovered. That is the sound choice for THIS heal — comparing
 * against the legacy fold would be the byte-wise judgement over mixed forms the
 * FEA-3743 guard on the first arm exists to avoid — but it does mean such a row
 * keeps whatever `main` stored. `sweepExpiredSessions` (session-maintenance.ts)
 * then filters it with `lastActivityAt: { lt: cutoff }`, a RAW TEXT comparison
 * with no `isCanonicalUtcTimestamp` hold-back — unlike its sibling stale sweep,
 * which holds such a row back — so a non-canonical text (e.g. a
 * `…+0530`-offset value) can byte-sort into the expiry window and be purged
 * irreversibly. That exposure is PRE-EXISTING and identical on `main`; adding
 * the hold-back is a behavior change on an irreversible path and is tracked
 * separately on ISS-5977, deliberately not made here.
 *
 * DISCOVERY is therefore TWO arms, and the original one is untouched. The
 * FEA-3591 `<` is a byte-wise TEXT comparison, so it keeps its ISS-5330 /
 * FEA-3743 canonical-'Z' guards on both operands and keeps deferring a row the
 * best-effort format heal has not yet normalized to a later boot. The ISS-5497
 * arm judges only where the CANONICAL fold applies: in legacy mode the fold is
 * `main`'s verbatim, so there is nothing this ticket corrects, and comparing
 * against it would be that same unsound byte-wise judgement. Where it does apply
 * the test is an inequality against the exact value the write path itself would
 * store, which needs no form guard at all. Both conditions are spelled as ONE
 * `COALESCE(<fold>, last_activity_at) IS NOT last_activity_at` rather than a
 * separate `IS NOT NULL` and `IS NOT`, because SQLite re-evaluates a correlated
 * subquery per interpolation and the fold is the expensive term — one
 * evaluation, identical row set (a NULL fold collapses to the column and
 * compares equal). Measured on 2,000 sessions / 80k events: 63ms spelled twice,
 * 40ms spelled once.
 *
 * The ISS-5497 arm is gated on three cheap disjuncts FIRST, and that ordering is
 * what makes it affordable at all: the fold reads the session's `events`, and a
 * row whose `started_at`, `last_activity_at`, and every date-shaped event are
 * ALREADY canonical cannot differ (canonicalizing an already-canonical operand
 * is the identity, so the new fold and the old byte-wise one return the same
 * text). That is the overwhelmingly common row, and it pays two globs and one
 * index probe instead of a fold.
 *
 * RESIDUAL COST, stated rather than hidden: the row set this heal WRITES is
 * convergent — a healed row's stored value equals the fold's, so neither arm
 * matches again — but the DISCOVERY scan is not free on the next boot.
 * `events.created_at` is deliberately outside `HEALED_COLUMNS` (it holds raw
 * harness text), so a session that ever held a non-canonical event keeps passing
 * the third disjunct forever and keeps paying for its fold. Measured above:
 * ~40ms per boot at 80k events, ~0.5µs/event, linear, on the awaited pre-sweep
 * path (`main` pays 0.3ms). Collapsing that to zero needs a persisted
 * "this corpus has been swept" marker, i.e. a schema migration, and gating on
 * `data_revision` instead is NOT a substitute — the rebuild's missing-source
 * bridge stamps the new revision without recomputing, which is one of the two
 * holes this heal exists to cover. Left as its own change.
 *
 * `updated_at` is bumped for every healed row EXCEPT `active` ones: bumping an
 * active row would lift it out of the orphan sweep's `updatedAt < cutoff`
 * predicate (`status = 'active'` is the only status the sweep watches) and
 * keep a genuinely-stale session alive. A stale active is instead swept with
 * the HEALED value (the sweep does its own `updated_at` bump) and a live
 * active keeps bumping through ordinary ingest. Every other status — terminal
 * rows AND `waiting` — gets the bump here, because nothing else is guaranteed
 * to ship the correction: a session parked in `waiting` forever would
 * otherwise never re-enter the sync cursor (PR #3334 review, P2).
 *
 * Convergent: healed rows satisfy the floor, so the discovery predicate stops
 * matching and the next boot is a no-op — no repeated sync-cursor churn.
 * Chunked with per-chunk watermarks and per-chunk error isolation like the
 * other store heals; a failed chunk is retried on the next boot. The result
 * reports `failedChunks` so the boot wiring can SKIP the destructive sweeps
 * for that boot — with unhealed rows still in the store, the orphan sweep
 * would stamp a pre-start `ended_at` (never re-derived) and the retention
 * sweep could permanently purge a row by its corrupted-older timestamp
 * (PR #3334 review, P1).
 */
export type SessionLastActivityFloorHealResult = {
  healed: number;
  failedChunks: number;
};

export async function healSessionLastActivityAtFloor(
  prisma: DesktopPrisma,
  now: string,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<SessionLastActivityFloorHealResult> {
  const violating = await prisma.client.$queryRawUnsafe<
    { id: string; status: string }[]
  >(
    // FEA-3591 / ISS-5330 / FEA-3743 — the ORIGINAL arm, unchanged. Its `<` is a
    // byte-wise TEXT comparison, so it keeps its canonical-'Z' guards on BOTH
    // operands: if the best-effort format heal fails on a boot, a mixed-form pair
    // would select (or skip) the wrong rows, so such a row is deferred to the
    // next boot whose format heal succeeds. Convergent either way, no regression
    // window.
    //
    // ISS-5497 (review) — the SECOND arm, and everything about its shape is
    // about not disturbing the first. It fires only where the CANONICAL fold
    // applies (`IS NOT NULL`), because in legacy mode the fold is `main`'s
    // verbatim: there is nothing this ticket corrects, and comparing against it
    // would be the very byte-wise judgement over mixed forms the guards above
    // avoid. Where it does apply the test is EXACT — an inequality against the
    // value the write path itself would store — so it needs no form guard.
    //
    // The three cheap disjuncts come FIRST and are the reason this is affordable
    // at boot: the fold reads the session's `events`, and a row whose
    // `started_at`, `last_activity_at`, and every date-shaped event are already
    // canonical cannot differ at all (canonicalizing an already-canonical operand
    // is the identity, so the ISS-5497 fold and the pre-ISS-5497 byte-wise one
    // return the same text). That is the overwhelmingly common row, and it costs
    // two globs and one index probe rather than a fold.
    `SELECT id, status
       FROM sessions
      WHERE (
              last_activity_at < ${SESSION_STARTED_AT_FLOOR_SQL}
              AND started_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
              AND last_activity_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
            )
         OR (
              (
                started_at NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                OR last_activity_at NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                OR EXISTS (
                     SELECT 1 FROM events e
                      WHERE e.session_id = sessions.id
                        AND e.created_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL}
                        AND e.created_at NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
                   )
              )
              AND COALESCE(${SESSION_CANONICAL_LAST_ACTIVITY_AT_SQL}, last_activity_at)
                  IS NOT last_activity_at
            )`
  );
  if (violating.length === 0) {
    return { healed: 0, failedChunks: 0 };
  }
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let healed = 0;
  let failedChunks = 0;
  for (let start = 0; start < violating.length; start += safeChunkSize) {
    const chunk = violating.slice(start, start + safeChunkSize);
    // FEA-3485: per-chunk watermark (see `chunkWatermark`) so a multi-chunk heal
    // does not collapse the whole healed set onto one sync-cursor top timestamp.
    const chunkNow = chunkWatermark(now, start / safeChunkSize);
    try {
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          for (const row of chunk) {
            await recomputeSessionLastActivityAt(tx, row.id);
          }
          const bumpIds = chunk
            .filter((row) => row.status !== SESSION_STATUS.ACTIVE)
            .map((row) => row.id);
          if (bumpIds.length > 0) {
            await bumpSessionsUpdatedAt(tx, bumpIds, chunkNow);
          }
        })
      );
      healed += chunk.length;
    } catch (error) {
      failedChunks += 1;
      log(
        `last-activity floor heal failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failedChunks > 0) {
    log(
      `last-activity floor heal: ${failedChunks} chunk(s) failed, will retry next boot`
    );
  }
  return { healed, failedChunks };
}

// SQL twin of `chooseConservedUsageCost`'s qualify branch (aliases: u =
// token_usage, e = the sums subquery above): fully priced series, exact
// per-bucket count reconciliation against the effective (current + baseline)
// counts, and a cost difference above the shared relative epsilon.
// FEA-3419 TTL parity: the four-counter match alone is no longer sufficient —
// token_usage and token_events commit in SEPARATE tolerant transactions, so a
// partial re-import can pair a TTL-priced usage row with stale events whose
// four counters still match; adopting that premium-free event sum would
// silently erase the premium. The usage row's split is present iff >= 1 event
// reported one (foldDedupMap semantics), so parity is: nullness agrees with
// the series' reported count, and when reported, the sums match exactly.
// Mismatch (either direction) disqualifies -> aggregate kept (fail closed).
const TOKEN_USAGE_EVENT_CONSERVATION_QUALIFIES = `u.cost_usd_estimated IS NOT NULL
    AND e.unpriced = 0
    AND e.i = u.input_tokens + u.baseline_input
    AND e.o = u.output_tokens + u.baseline_output
    AND e.cr = u.cache_read_tokens + u.baseline_cache_read
    AND e.cw = u.cache_write_tokens + u.baseline_cache_write
    AND ((u.cache_write_1h_tokens IS NULL AND e.ttl_reported = 0)
      OR (u.cache_write_1h_tokens IS NOT NULL
        AND e.ttl_reported > 0
        AND e.cw5m = COALESCE(u.cache_write_5m_tokens, 0)
        AND e.cw1h = COALESCE(u.cache_write_1h_tokens, 0)))
    AND ABS(e.cost - u.cost_usd_estimated) > ${TOKEN_COST_CONSERVATION_RELATIVE_EPS} * MAX(1, ABS(e.cost), ABS(u.cost_usd_estimated))`;

function conservationSumKey(sessionId: string, model: string): string {
  return `${sessionId}\u0000${model}`;
}

/** Multi-session variant of `selectTokenEventConservationSums` for the boot
 * reprice pass — keyed by `conservationSumKey(session, model)`. */
async function selectTokenEventConservationSumsBySession(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<Map<string, TokenEventConservationSums>> {
  if (sessionIds.length === 0) {
    return new Map();
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await tx.$queryRawUnsafe<TokenEventConservationSumRow[]>(
    `SELECT session_id, model, i, o, cr, cw, cw5m, cw1h, ttl_reported, cost, unpriced, event_count
       FROM (${TOKEN_EVENT_CONSERVATION_SUMS_SUBQUERY})
      WHERE session_id IN (${placeholders})`,
    ...sessionIds
  );
  return new Map(
    rows.map((row) => [
      conservationSumKey(row.session_id ?? "", row.model),
      conservationSumsFromRow(row),
    ])
  );
}

/**
 * FEA-3488: batched form of {@link updateSessionCostRollup} — recomputes the
 * per-session `sessions.cost_usd_estimated` / `cost_currency` / `cost_source`
 * snapshot for a whole set of sessions in ONE `GROUP BY session_id` aggregate
 * over `token_usage` plus a single batched `UPDATE`, replacing the boot-reprice
 * N+1 (2 serial queries per session on the transaction client). Behavior is
 * identical to running `updateSessionCostRollup` per id — same computed cost,
 * currency, and source, same rows updated — just folded into set-based SQL.
 * Mirrors the batching idiom of `upsertSessionAnalyticsRollupBatch` (single
 * IN-list scan, LEFT JOIN over a per-session GROUP BY aggregate). A single
 * transaction client serializes queries anyway, so no Promise.all.
 */
async function updateSessionCostRollupBatch(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  // $1 = GenaiPricesV1, $2 = PricingTableV1, $3 = Usd; the session ids occupy
  // $4..$(N+3). The IN list is repeated for the token_usage aggregate and the
  // outer sessions scan; reusing the same numbered params keeps one bound array
  // (SQLite binds `?N` by index, not textual order — see prisma-client.ts).
  const idPlaceholders = sessionIds.map((_, i) => `$${i + 4}`).join(", ");
  const params: unknown[] = [
    ModelPricingSource.GenaiPricesV1,
    ModelPricingSource.PricingTableV1,
    ModelPricingCurrency.Usd,
    ...sessionIds,
  ];
  // Faithful set-based translation of updateSessionCostRollup:
  //  - token_cost_usd / priced_rows / token_cost_source come from the SAME
  //    per-session aggregate over token_usage (Genai source wins over Table);
  //  - web_search_cost_usd is the per-request session-level line item read from
  //    the persisted metadata via the SHARED `webSearchCostSql` fragment — the
  //    identical single source the analytics est_cost rollup prices — already
  //    MAX(0,…)-guarded and non-null, so it is added exactly once and never
  //    double-counted (web-search cost never lives in a token_usage row);
  //  - FEA-3419: the FEA-3636 ttl_premium_usd term is GONE — the 1h premium is
  //    baked into per-event / per-model costs by estimateTokenCost, so the
  //    token_usage sum already carries it;
  //  - hasCost = pricedRows > 0 OR webSearch > 0; when false, all three columns
  //    NULL out — matching the per-session UPDATE exactly. A LEFT JOIN keeps
  //    sessions with no token_usage rows (tok.* NULL → coalesced) so every id
  //    in the batch is updated, just as the per-session loop did.
  await tx.$executeRawUnsafe(
    `UPDATE sessions
     SET
       cost_usd_estimated = CASE
         WHEN agg.priced_rows > 0 OR agg.web_search_cost_usd > 0
           THEN agg.token_cost_usd + agg.web_search_cost_usd
         ELSE NULL
       END,
       cost_currency = CASE
         WHEN agg.priced_rows > 0 OR agg.web_search_cost_usd > 0 THEN $3
         ELSE NULL
       END,
       cost_source = CASE
         WHEN agg.priced_rows > 0 OR agg.web_search_cost_usd > 0
           THEN COALESCE(
                  agg.token_cost_source,
                  CASE WHEN agg.web_search_cost_usd > 0 THEN $1 ELSE NULL END
                )
         ELSE NULL
       END
     FROM (
       SELECT
         src.id AS session_id,
         COALESCE(tok.cost_usd, 0) AS token_cost_usd,
         COALESCE(tok.priced_rows, 0) AS priced_rows,
         tok.cost_source AS token_cost_source,
         ${webSearchCostSql("src.metadata")} AS web_search_cost_usd
       FROM sessions src
       LEFT JOIN (
         SELECT
           session_id,
           COALESCE(SUM(cost_usd_estimated), 0) AS cost_usd,
           COUNT(cost_usd_estimated) AS priced_rows,
           CASE
             WHEN SUM(CASE WHEN cost_source = $1 THEN 1 ELSE 0 END) > 0 THEN $1
             WHEN SUM(CASE WHEN cost_source = $2 THEN 1 ELSE 0 END) > 0 THEN $2
             ELSE NULL
           END AS cost_source
         FROM token_usage
         WHERE session_id IN (${idPlaceholders})
         GROUP BY session_id
       ) tok ON tok.session_id = src.id
       WHERE src.id IN (${idPlaceholders})
     ) AS agg
     WHERE sessions.id = agg.session_id`,
    ...params
  );
}

/**
 * Run the cost-rollup heal sequence in its required order, isolating each pass
 * so a transient failure in one never skips the rest.
 *
 * The four passes are ordered by data dependency, not convenience: re-pricing
 * resolves NULL costs first, the cache split then corrects the event
 * components, conservation compares `token_usage.cost` against those settled
 * event sums, and only then can the session rollup be recomputed without the
 * removed TTL-premium term. Keeping the sequence here — rather than spelled out
 * in the boot chain — is what stops a caller from reordering it by accident.
 */
export async function runCostRollupHealPasses(
  prisma: DesktopPrisma,
  log: (message: string) => void
): Promise<void> {
  await repriceUnpricedTokenUsage(prisma, log).catch(() => undefined);
  await healCacheCostSplit(prisma, log).catch(() => undefined);
  await healTokenUsageEventConservation(prisma, log).catch(() => undefined);
  await healSessionRollupAfterTtlPremiumRemoval(prisma, log).catch(
    () => undefined
  );
}
