/**
 * @file token-cost-writes.ts
 * @description The desktop token-cost WRITE primitives + the token-cost
 * CONSERVATION invariant, extracted from write-core.ts (ISS-4936) to shrink that
 * grandfathered file. This is the hot-path pricing/write core: it prices token
 * usage and events via `estimateTokenCost`, reconciles per-event vs per-model
 * cost (`chooseConservedUsageCost` / `tokenCostsConserved` — the long-context
 * per-request tier means one aggregate price over-charges, so a row's cost is
 * the event-sum when its series reconciles exactly and fails closed to the
 * aggregate otherwise), and rolls the total up to `sessions.cost_usd_estimated`
 * (`updateSessionCostRollup`, including the shared `webSearchCostSql` line item).
 *
 * Pure LEAF: imports only leaf modules (never write-core.js / live-hook.js /
 * token-cost-maintenance.js / session-analytics-rollup.js), so those import
 * FROM here one-directionally — no cycle. `webSearchCostSql` lives here because
 * it is the single source both the session cost rollup (here) and
 * session-analytics-rollup's `session_analytics.est_cost` rollup read, so the
 * two can never diverge.
 */
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import {
  type EstimateTokenCostResult,
  estimateTokenCost,
} from "../../shared/token-cost.js";
import { reportTokenCostPricingMiss } from "../cost/token-cost-pricing-miss.js";
import {
  ModelPricingCurrency,
  ModelPricingSource,
} from "../model-pricing/model-pricing-fixture.js";
import { tokenCountValue } from "./db-helpers.js";
import type { TokenUsagePricingRow } from "./db-row-types.js";
import type { Prisma } from "./generated/client.js";
import {
  type PersistedTokenEventRecord,
  serializeTokenEventCostSummary,
  type TokenEventRecord,
} from "./token-event-contract.js";
import { TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER } from "./token-parity.js";

/**
 * PRD-538: session-level web-search cost, in USD, derived from the persisted
 * `$.usageExtras.web_search_requests` count in a session's metadata blob. This is
 * the SINGLE source both cost writers read — `updateSessionCostRollup` (the
 * authoritative `sessions.cost_usd_estimated`) and the `session_analytics.est_cost`
 * rollup — so the two surfaces price web search identically and can never diverge.
 * Web search is billed per-request (a server-side tool), never per-token, so this
 * is always additive to and disjoint from any `token_usage` cost. Yields 0 for
 * absent/invalid metadata or a missing/≤0 count (json_valid + max(0, …) guards),
 * so non-web-search sessions are unaffected.
 */
export function webSearchCostSql(metadataCol: string): string {
  // NOTE: json_extract returns NULL when the path is ABSENT even for valid JSON
  // (the common case — the field is only persisted when > 0), and SQLite's
  // scalar max(0, NULL) is NULL, which would poison an additive `x + <this>` to
  // NULL. So COALESCE the extract to 0 BEFORE the max/cast so this fragment is
  // always a concrete non-negative number and never nullifies its sum.
  return `(MAX(0, CAST(COALESCE(
     CASE WHEN json_valid(${metadataCol})
          THEN json_extract(${metadataCol}, '$.usageExtras.web_search_requests')
          ELSE 0 END, 0
   ) AS INTEGER)) * ${WEB_SEARCH_COST_PER_REQUEST_USD})`;
}

// FEA-3232: Σ(token_events.cost) must equal token_usage.cost when both stores
// describe the same requests. Same relative epsilon as the golden-layer2
// `conserved()` predicate; at or below it the aggregate estimate is kept, so
// flat-rate models (where the two only differ by float-summation ulps) stay
// bit-identical to pre-fix values.
export const TOKEN_COST_CONSERVATION_RELATIVE_EPS = 1e-9;

export function tokenCostsConserved(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    TOKEN_COST_CONSERVATION_RELATIVE_EPS * Math.max(1, Math.abs(a), Math.abs(b))
  );
}

// Per-(session, model) token_events sums, as a JOINable subquery — the SQL twin
// of `selectTokenEventConservationSums` used by the boot heal's candidate and
// chunk queries.
export const TOKEN_EVENT_CONSERVATION_SUMS_SUBQUERY = `SELECT session_id, model,
    COALESCE(SUM(input_tokens), 0) AS i,
    COALESCE(SUM(output_tokens), 0) AS o,
    COALESCE(SUM(cache_read_tokens), 0) AS cr,
    COALESCE(SUM(cache_write_tokens), 0) AS cw,
    COALESCE(SUM(cache_write_5m_tokens), 0) AS cw5m,
    COALESCE(SUM(cache_write_1h_tokens), 0) AS cw1h,
    COALESCE(SUM(CASE WHEN cache_write_1h_tokens IS NULL THEN 0 ELSE 1 END), 0) AS ttl_reported,
    COALESCE(SUM(cost_usd_estimated), 0) AS cost,
    COALESCE(SUM(CASE WHEN cost_usd_estimated IS NULL THEN 1 ELSE 0 END), 0) AS unpriced,
    COUNT(*) AS event_count
  FROM token_events
  GROUP BY session_id, model`;

export type TokenEventConservationSums = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** FEA-3419: series TTL sums (absent events contribute 0) + reported count. */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  ttlReportedCount: number;
  costUsd: number;
  unpricedCount: number;
  eventCount: number;
};

/**
 * Deduplicate and sort an optional model list, returning `null` (no filter) when
 * `models` is undefined and the SQL ` AND model IN (...)` clause starting at the
 * given parameter offset. Shared by `selectTokenEventConservationSums` and
 * `selectTokenUsagePricingRows` which both scope a per-session query by model.
 */
function buildModelFilterClause(
  models: string[] | undefined,
  paramOffset: number
): { uniqueModels: string[] | null; modelFilter: string } {
  const uniqueModels =
    models === undefined
      ? null
      : [...new Set(models.filter((m) => m.length > 0))].sort();
  const modelFilter =
    uniqueModels === null || uniqueModels.length === 0
      ? ""
      : ` AND model IN (${uniqueModels.map((_, i) => `$${i + paramOffset}`).join(", ")})`;
  return { uniqueModels, modelFilter };
}

/**
 * Per-model sums over a session's PERSISTED token_events — the full series,
 * not whatever subset the caller happens to hold. The live-hook path passes
 * only newly-appended events to `persistImportedTokenCosts`, so summing its
 * in-memory argument would never reconcile against the cumulative token_usage
 * counts; reading the store inside the same transaction does.
 */
async function selectTokenEventConservationSums(
  tx: Prisma.TransactionClient,
  sessionId: string,
  models?: string[]
): Promise<Map<string, TokenEventConservationSums>> {
  const { uniqueModels, modelFilter } = buildModelFilterClause(models, 2);
  if (uniqueModels?.length === 0) {
    return new Map();
  }
  const rows = await tx.$queryRawUnsafe<TokenEventConservationSumRow[]>(
    `SELECT model, i, o, cr, cw, cw5m, cw1h, ttl_reported, cost, unpriced, event_count
       FROM (${TOKEN_EVENT_CONSERVATION_SUMS_SUBQUERY})
      WHERE session_id = $1${modelFilter}`,
    ...(uniqueModels === null ? [sessionId] : [sessionId, ...uniqueModels])
  );
  return new Map(rows.map((row) => [row.model, conservationSumsFromRow(row)]));
}

export type TokenEventConservationSumRow = {
  session_id?: string;
  model: string;
  i: unknown;
  o: unknown;
  cr: unknown;
  cw: unknown;
  cw5m: unknown;
  cw1h: unknown;
  ttl_reported: unknown;
  cost: number | null;
  unpriced: unknown;
  event_count: unknown;
};

export function conservationSumsFromRow(
  row: TokenEventConservationSumRow
): TokenEventConservationSums {
  return {
    inputTokens: tokenCountValue(row.i, "conservation.input"),
    outputTokens: tokenCountValue(row.o, "conservation.output"),
    cacheReadTokens: tokenCountValue(row.cr, "conservation.cache_read"),
    cacheWriteTokens: tokenCountValue(row.cw, "conservation.cache_write"),
    cacheWrite5mTokens: tokenCountValue(
      row.cw5m,
      "conservation.cache_write_5m"
    ),
    cacheWrite1hTokens: tokenCountValue(
      row.cw1h,
      "conservation.cache_write_1h"
    ),
    ttlReportedCount: tokenCountValue(
      row.ttl_reported,
      "conservation.ttl_reported"
    ),
    costUsd: Number(row.cost ?? 0),
    unpricedCount: tokenCountValue(row.unpriced, "conservation.unpriced_count"),
    eventCount: tokenCountValue(row.event_count, "conservation.event_count"),
  };
}

/**
 * FEA-3232: choose the token_usage cost. The published long-context tier is a
 * per-REQUEST property, so when the row's complete, fully-priced event series
 * reconciles exactly with the effective counts, the sum of per-request prices
 * is the session cost — one aggregate calcPrice call would price the entire
 * session at whatever tier the LIFETIME prompt volume lands in (the exemplar:
 * 36.8M "context" tokens ⇒ everything at gpt-5.4's >272K rate). Fails closed
 * to the aggregate estimate whenever the series cannot prove it covers the row:
 * unpriced events, count mismatch (compaction baselines, partial hook capture),
 * OTel-only rows, or no events at all.
 */
export function chooseConservedUsageCost(
  aggregate: EstimateTokenCostResult,
  effective: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  parityEligible: boolean,
  sums: TokenEventConservationSums | undefined,
  /**
   * FEA-3419: the usage row's current-only TTL split (null members = never
   * reported). Series parity is required before the event sum may replace the
   * aggregate — see TOKEN_USAGE_EVENT_CONSERVATION_QUALIFIES for the rationale
   * (partial re-imports can pair a TTL-priced usage row with stale events).
   */
  usageTtl: { fiveM: number | null; oneH: number | null }
): EstimateTokenCostResult {
  if (!parityEligible) {
    return aggregate;
  }
  if (!sums || sums.eventCount === 0 || sums.unpricedCount > 0) {
    return aggregate;
  }
  if (
    sums.inputTokens !== effective.inputTokens ||
    sums.outputTokens !== effective.outputTokens ||
    sums.cacheReadTokens !== effective.cacheReadTokens ||
    sums.cacheWriteTokens !== effective.cacheWriteTokens
  ) {
    return aggregate;
  }
  // FEA-3419 TTL parity (JS twin of the SQL predicate): nullness must agree
  // with the series' reported count, and a reported split must sum-match.
  const usageTtlReported = usageTtl.oneH !== null;
  if (usageTtlReported !== sums.ttlReportedCount > 0) {
    return aggregate;
  }
  if (
    usageTtlReported &&
    (sums.cacheWrite5mTokens !== (usageTtl.fiveM ?? 0) ||
      sums.cacheWrite1hTokens !== (usageTtl.oneH ?? 0))
  ) {
    return aggregate;
  }
  if (tokenCostsConserved(sums.costUsd, aggregate.costUsd)) {
    return aggregate;
  }
  return { ...aggregate, costUsd: sums.costUsd };
}

export async function persistImportedTokenCosts(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    harness: string;
    tokenUsageObservedAt: string;
    tokenUsageModels?: string[];
    tokenEvents: PersistedTokenEventRecord[];
    tokenEventObservedAtFallback: string;
  }
): Promise<void> {
  // Events are priced FIRST so the conservation read below observes a fully
  // priced series — both call sites (full import and live-hook append) insert
  // the event rows before calling here, in the same transaction.
  for (const event of input.tokenEvents) {
    const observedAt = event.timestamp || input.tokenEventObservedAtFallback;
    const costInput = {
      model: event.model,
      inputTokens: event.input,
      outputTokens: event.output,
      cacheReadTokens: event.cacheRead,
      cacheWriteTokens: event.cacheWrite,
      // FEA-3419: price the event's own one-hour cache writes at the 2x rate,
      // per call at the event's model/tier (ruling: rates are PER-CALL). The 5m
      // portion and any unclassified residual stay at the library's default rate.
      ...(event.cacheWriteTtl
        ? { cacheWrite1hTokens: event.cacheWriteTtl.oneH }
        : {}),
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      reportTokenCostPricingMiss(
        costInput,
        "imported_token_costs",
        input.sessionId
      );
    }
    await updateTokenEventCost(
      tx,
      input.sessionId,
      event,
      estimate,
      observedAt
    );
  }

  const usageRows = await selectTokenUsagePricingRows(
    tx,
    input.sessionId,
    input.tokenUsageModels
  );
  const conservationSums =
    usageRows.length > 0
      ? await selectTokenEventConservationSums(
          tx,
          input.sessionId,
          input.tokenUsageModels
        )
      : new Map<string, TokenEventConservationSums>();
  for (const row of usageRows) {
    const observedAt = row.created_at ?? input.tokenUsageObservedAt;
    // FEA-3419: current-only TTL columns (compaction baselines carry no
    // per-request data → unclassified → default 5m rate, the FEA-3232
    // fail-closed posture). NULL = the provider never reported a breakdown.
    const usageTtl = {
      fiveM:
        row.cache_write_5m_tokens == null
          ? null
          : tokenCountValue(
              row.cache_write_5m_tokens,
              "pricing.cache_write_5m"
            ),
      oneH:
        row.cache_write_1h_tokens == null
          ? null
          : tokenCountValue(
              row.cache_write_1h_tokens,
              "pricing.cache_write_1h"
            ),
    };
    const costInput = {
      model: row.model,
      inputTokens: tokenCountValue(row.input_tokens, "pricing.input"),
      outputTokens: tokenCountValue(row.output_tokens, "pricing.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "pricing.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "pricing.cache_write"
      ),
      ...(usageTtl.oneH === null ? {} : { cacheWrite1hTokens: usageTtl.oneH }),
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      reportTokenCostPricingMiss(
        costInput,
        "imported_token_costs",
        input.sessionId
      );
    }
    const conserved = estimate
      ? chooseConservedUsageCost(
          estimate,
          costInput,
          Number(row.parity_eligible) === 1,
          conservationSums.get(row.model),
          usageTtl
        )
      : estimate;
    await updateTokenUsageCost(
      tx,
      input.sessionId,
      row.model,
      conserved,
      observedAt
    );
  }

  await updateSessionCostRollup(tx, input.sessionId);
}

async function selectTokenUsagePricingRows(
  tx: Prisma.TransactionClient,
  sessionId: string,
  models?: string[]
): Promise<TokenUsagePricingRow[]> {
  const { uniqueModels, modelFilter } = buildModelFilterClause(models, 2);
  if (uniqueModels?.length === 0) {
    return [];
  }
  return tx.$queryRawUnsafe<TokenUsagePricingRow[]>(
    // FEA-2879: price the EFFECTIVE total (post-compaction current_* plus the
    // pre-compaction totals rolled into baseline_* by upsertTokenUsage). A
    // transcript compaction shrinks the re-derived current_* counts; pricing
    // current-only would silently undercount already-incurred spend. This is
    // the reader half of the write's `effective_total = baseline + current`
    // contract (see read-stores.ts). The aliases keep the row shape unchanged.
    `SELECT
       model,
       input_tokens + baseline_input AS input_tokens,
       output_tokens + baseline_output AS output_tokens,
       cache_read_tokens + baseline_cache_read AS cache_read_tokens,
       cache_write_tokens + baseline_cache_write AS cache_write_tokens,
       cache_write_5m_tokens,
       cache_write_1h_tokens,
       created_at,
       (${TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER}) AS parity_eligible
     FROM token_usage
     WHERE session_id = $1${modelFilter}
     ORDER BY model ASC`,
    ...(uniqueModels === null ? [sessionId] : [sessionId, ...uniqueModels])
  );
}

export async function updateTokenUsageCost(
  tx: Prisma.TransactionClient,
  sessionId: string,
  model: string,
  estimate: EstimateTokenCostResult | undefined,
  observedAt: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE token_usage SET
       cost_usd_estimated = $1,
       cost_currency = $2,
       cost_source = $3,
       cost_observed_at = $4
     WHERE session_id = $5 AND model = $6`,
    estimate?.costUsd ?? null,
    estimate ? ModelPricingCurrency.Usd : null,
    estimate ? ModelPricingSource.GenaiPricesV1 : null,
    estimate ? observedAt : null,
    sessionId,
    model
  );
}

export async function updateTokenEventCost(
  tx: Prisma.TransactionClient,
  sessionId: string,
  event: TokenEventRecord,
  estimate: EstimateTokenCostResult | undefined,
  observedAt: string
): Promise<void> {
  const costSummary =
    event.transportId === undefined
      ? null
      : serializeTokenEventCostSummary(event, estimate?.costUsd);
  // token_events is @@ignore'd (no PK → no generated delegate), so this stays
  // raw on the prisma tx client.
  await tx.$executeRawUnsafe(
    `UPDATE token_events SET
       cost_usd_estimated = $1,
       input_cost_usd_estimated = $2,
       output_cost_usd_estimated = $3,
       cache_read_cost_usd_estimated = $4,
       cache_creation_cost_usd_estimated = $5,
       cost_currency = $6,
       cost_source = $7,
       cost_observed_at = $8,
       cost_summary = CASE
         WHEN transport_id IS NULL THEN cost_summary
         ELSE $9
       END
     WHERE session_id = $10
       AND (
         ($11 IS NOT NULL AND transport_id = $11)
         OR (
           $11 IS NULL
           AND transport_id IS NULL
           AND model = $12
           AND created_at = $13
           AND input_tokens = $14
           AND output_tokens = $15
           AND cache_read_tokens = $16
           AND cache_write_tokens = $17
           AND cache_write_5m_tokens IS $18
           AND cache_write_1h_tokens IS $19
         )
       )`,
    estimate?.costUsd ?? null,
    estimate?.inputCostUsd ?? null,
    estimate?.outputCostUsd ?? null,
    estimate?.cacheReadCostUsd ?? null,
    estimate?.cacheWriteCostUsd ?? null,
    estimate ? ModelPricingCurrency.Usd : null,
    estimate ? ModelPricingSource.GenaiPricesV1 : null,
    estimate ? observedAt : null,
    costSummary,
    sessionId,
    event.transportId ?? null,
    event.model,
    event.timestamp,
    event.input,
    event.output,
    event.cacheRead,
    event.cacheWrite,
    // FEA-3419: the legacy fallback locator still needs the null-safe TTL pair.
    // Without it, two pre-transport rows identical in timestamp/model/counts but
    // differing in split would BOTH match and take the last-priced value,
    // corrupting the per-event costs conservation reconciles against. SQLite
    // `IS` matches NULL-to-NULL as equal, so absent-provenance rows locate.
    event.cacheWriteTtl ? event.cacheWriteTtl.fiveM : null,
    event.cacheWriteTtl ? event.cacheWriteTtl.oneH : null
  );
}

export async function updateSessionCostRollup(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<
    {
      cost_usd: number | null;
      priced_rows: number;
      cost_source: string | null;
    }[]
  >(
    `SELECT
       COALESCE(SUM(cost_usd_estimated), 0) AS cost_usd,
       COUNT(cost_usd_estimated) AS priced_rows,
       CASE
         WHEN SUM(CASE WHEN cost_source = $2 THEN 1 ELSE 0 END) > 0 THEN $2
         WHEN SUM(CASE WHEN cost_source = $3 THEN 1 ELSE 0 END) > 0 THEN $3
         ELSE NULL
       END AS cost_source
     FROM token_usage
     WHERE session_id = $1`,
    sessionId,
    ModelPricingSource.GenaiPricesV1,
    ModelPricingSource.PricingTableV1
  );
  const tokenCostUsd = Number(rows[0]?.cost_usd ?? 0);
  const pricedRows = Number(rows[0]?.priced_rows ?? 0);
  const tokenCostSource = rows[0]?.cost_source ?? null;

  // Web search is billed per request, not per token, so it is a SESSION-level
  // line item — read ONCE from the persisted usageExtras and added exactly once
  // here, never on a per-model token_usage row. Because this rollup recomputes
  // the total from scratch on every call, re-pricing / re-import can never
  // double-count it (the guard the whole design turns on). The cost is derived
  // via the SHARED `webSearchCostSql` fragment — the identical source the
  // session_analytics.est_cost rollup uses — so the authoritative total and the
  // analytics rollup price web search identically and can never diverge.
  // FEA-3419: the FEA-3636 session-level 1h TTL premium term is GONE — the
  // premium is baked into per-event / per-model costs by estimateTokenCost
  // (cacheWrite1hTokens), so the token_usage sum already carries it.
  const lineItemRows = await tx.$queryRawUnsafe<
    { web_search_cost_usd: number | null }[]
  >(
    `SELECT ${webSearchCostSql("metadata")} AS web_search_cost_usd
     FROM sessions
     WHERE id = $1`,
    sessionId
  );
  const webSearchCostUsd = Math.max(
    0,
    Number(lineItemRows[0]?.web_search_cost_usd ?? 0) || 0
  );

  const hasCost = pricedRows > 0 || webSearchCostUsd > 0;
  const totalCostUsd = tokenCostUsd + webSearchCostUsd;
  const costSource =
    tokenCostSource ??
    (webSearchCostUsd > 0 ? ModelPricingSource.GenaiPricesV1 : null);

  await tx.$executeRawUnsafe(
    `UPDATE sessions SET
       cost_usd_estimated = $1,
       cost_currency = $2,
       cost_source = $3
     WHERE id = $4`,
    hasCost ? totalCostUsd : null,
    hasCost ? ModelPricingCurrency.Usd : null,
    hasCost ? costSource : null,
    sessionId
  );
}
