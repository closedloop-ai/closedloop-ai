/**
 * @file token-cost-writes.ts
 * @description The desktop token-cost WRITE primitives + the token-cost
 * CONSERVATION invariant, extracted from write-core.ts (ISS-4936) to shrink that
 * file rather than grow it. This is the hot-path pricing/write core: it prices token
 * usage and events via `estimateTokenCost`, reconciles per-event vs per-model
 * cost (`chooseConservedUsageCost` / `tokenCostsConserved` — the long-context
 * per-request tier means one aggregate price over-charges, so a row's cost is
 * the event-sum when its series reconciles exactly and fails closed to the
 * aggregate otherwise), and rolls the total up to `sessions.cost_usd_estimated`
 * (`updateSessionCostRollup`, including the shared `webSearchCostSql` line item).
 *
 * Pure LEAF: imports only leaf modules (never write-core.js / live-hook.js /
 * token-cost-maintenance.js / session-analytics-rollup.js), so those import
 * FROM here one-directionally — no cycle. `webSearchCostSql` and
 * `updateSessionCostRollupBatch` live here because they are what
 * session-analytics-rollup.js calls to keep `sessions.cost_usd_estimated` and
 * `session_analytics.est_cost` on one derivation (ISS-7776).
 */
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import { SESSION_WEB_SEARCH_REQUESTS_JSON_PATH } from "@repo/cost/session-web-search-cost";
import {
  type EstimateTokenCostResult,
  estimateTokenCost,
} from "../../shared/token-cost.js";
import { reportTokenCostPricingMiss } from "../cost/token-cost-pricing-miss.js";
import {
  MODEL_PRICING_SOURCE_WEAKEST_FIRST,
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
 * rollup — so the two surfaces PRICE web search identically. Pricing it the same
 * way is not the same as agreeing: ISS-7776 measured a $0.03 gap when only the
 * analytics rollup re-ran, and what closes it is the shared REFRESH below
 * (`updateSessionCostRollupBatch`), not this fragment.
 * Web search is billed per-request (a server-side tool), never per-token, so this
 * is always additive to and disjoint from any `token_usage` cost. Yields 0 for
 * absent/invalid metadata or a missing/≤0 count (json_valid + max(0, …) guards),
 * so non-web-search sessions are unaffected.
 *
 * ISS-7821: the JSON path is `SESSION_WEB_SEARCH_REQUESTS_JSON_PATH`, shared with
 * the cloud's JS reader (`sessionWebSearchCostUsd`), which prices the same line
 * item onto `SessionDetail.estimatedCost`. SQL and JS cannot share an
 * implementation; the PATH is the part they can share, and it is the part that
 * would silently report "no web search" for the whole fleet if it drifted.
 */
export function webSearchCostSql(metadataCol: string): string {
  // NOTE: json_extract returns NULL when the path is ABSENT even for valid JSON
  // (the common case — the field is only persisted when > 0), and SQLite's
  // scalar max(0, NULL) is NULL, which would poison an additive `x + <this>` to
  // NULL. So COALESCE the extract to 0 BEFORE the max/cast so this fragment is
  // always a concrete non-negative number and never nullifies its sum.
  return `(MAX(0, CAST(COALESCE(
     CASE WHEN json_valid(${metadataCol})
          THEN json_extract(${metadataCol}, '${SESSION_WEB_SEARCH_REQUESTS_JSON_PATH}')
          ELSE 0 END, 0
   ) AS INTEGER)) * ${WEB_SEARCH_COST_PER_REQUEST_USD})`;
}

/**
 * ISS-7762: the `CASE` ladder that folds a session's per-model `cost_source`
 * values into ONE session-level source, weakest provenance first.
 *
 * Binds one parameter per `MODEL_PRICING_SOURCE_WEAKEST_FIRST` member, starting
 * at `firstParamIndex`; the caller must bind that array, in that order, at those
 * positions. Shared by BOTH session rollups — the per-session
 * `updateSessionCostRollup` here and the set-based `updateSessionCostRollupBatch`
 * in token-cost-maintenance.ts — for the same reason `webSearchCostSql` above is
 * shared: two hand-written copies of one precedence WILL drift, and a drifted
 * copy makes a session's provenance depend on which writer touched it last.
 */
export function costSourcePrecedenceSql(firstParamIndex: number): string {
  const whens = MODEL_PRICING_SOURCE_WEAKEST_FIRST.map((_, i) => {
    const param = `$${firstParamIndex + i}`;
    return `WHEN SUM(CASE WHEN cost_source = ${param} THEN 1 ELSE 0 END) > 0 THEN ${param}`;
  }).join("\n         ");
  return `CASE
         ${whens}
         ELSE NULL
       END`;
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
    pricingSourceForEstimate(estimate),
    estimate ? observedAt : null,
    sessionId,
    model
  );
}

export async function updateTokenEventCost(
  tx: Pick<Prisma.TransactionClient, "$executeRawUnsafe">,
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
  const costParams = [
    estimate?.costUsd ?? null,
    estimate?.inputCostUsd ?? null,
    estimate?.outputCostUsd ?? null,
    estimate?.cacheReadCostUsd ?? null,
    estimate?.cacheWriteCostUsd ?? null,
    estimate ? ModelPricingCurrency.Usd : null,
    pricingSourceForEstimate(estimate),
    estimate ? observedAt : null,
  ];
  if (event.transportId === undefined) {
    await tx.$executeRawUnsafe(
      TOKEN_EVENT_COST_LEGACY_UPDATE_SQL,
      ...costParams,
      sessionId,
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
    return;
  }
  await tx.$executeRawUnsafe(
    TOKEN_EVENT_COST_TRANSPORT_UPDATE_SQL,
    ...costParams,
    costSummary,
    sessionId,
    event.transportId
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
       ${costSourcePrecedenceSql(2)} AS cost_source
     FROM token_usage
     WHERE session_id = $1`,
    sessionId,
    ...MODEL_PRICING_SOURCE_WEAKEST_FIRST
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
  // session_analytics.est_cost rollup uses.
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
  // KNOWN OVERSTATEMENT, PRE-EXISTING AND DELIBERATELY NOT WIDENED HERE: when a
  // session's ONLY cost is the web-search line item, this stamps
  // `genai_prices_v1` for a price that came from the hardcoded
  // `WEB_SEARCH_COST_PER_REQUEST_USD` constant — genai-prices is never consulted
  // for web search at all. That is the same class of defect as ISS-7762, one
  // field over, and naming it honestly needs a source value that does not exist
  // yet (`web_search_v1`), which is a vocabulary call for the operator rather
  // than something to invent mid-fix. Reachable only when every token row is
  // unpriced AND the session reports web-search requests. Left exactly as found.
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
 *
 * ISS-7776 moved it here, out of token-cost-maintenance.js, so the analytics
 * rollup can call it without the cycle that file's other imports would create.
 * That makes this the ONE writer of the authoritative total, per id set.
 */
export async function updateSessionCostRollupBatch(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  options: SessionCostRollupBatchOptions = {}
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  // $1 = Usd, $2 = GenaiPricesV1 (the web-search line item's own source), and
  // $3..$(S+2) are the weakest-first pricing sources bound for the SHARED
  // `costSourcePrecedenceSql` ladder; the session ids follow. The IN list is
  // repeated for the token_usage aggregate and the outer sessions scan; reusing
  // the same numbered params keeps one bound array (SQLite binds `?N` by index,
  // not textual order — see prisma-client.ts).
  const precedenceFirstParam = 3;
  const idFirstParam =
    precedenceFirstParam + MODEL_PRICING_SOURCE_WEAKEST_FIRST.length;
  const idPlaceholders = sessionIds
    .map((_, i) => `$${i + idFirstParam}`)
    .join(", ");
  const params: unknown[] = [
    ModelPricingCurrency.Usd,
    ModelPricingSource.GenaiPricesV1,
    ...MODEL_PRICING_SOURCE_WEAKEST_FIRST,
    ...sessionIds,
  ];
  // ISS-7776: the guard DECLINES the write; it does not clear the columns. It
  // lives in the outer WHERE so a partially- or un-priced session is simply not
  // among the updated rows — see the option's docstring for why "stale" and not
  // "NULL" is the contract this repo already landed.
  const pricedTokenUsageGuard = options.requireFullyPricedTokenUsage
    ? ` AND ${fullyPricedTokenUsageSql("agg.priced_rows", "agg.token_usage_rows")}`
    : "";
  // Faithful set-based translation of updateSessionCostRollup:
  //  - token_cost_usd / priced_rows / token_cost_source come from the SAME
  //    per-session aggregate over token_usage. ISS-7762: the source precedence
  //    is WEAKEST-wins and is built from the SHARED ladder the per-session
  //    rollup uses, so the two can never disagree about which source wins;
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
         WHEN agg.priced_rows > 0 OR agg.web_search_cost_usd > 0 THEN $1
         ELSE NULL
       END,
       cost_source = CASE
         WHEN agg.priced_rows > 0 OR agg.web_search_cost_usd > 0
           THEN COALESCE(
                  agg.token_cost_source,
                  CASE WHEN agg.web_search_cost_usd > 0 THEN $2 ELSE NULL END
                )
         ELSE NULL
       END
     FROM (
       SELECT
         src.id AS session_id,
         COALESCE(tok.cost_usd, 0) AS token_cost_usd,
         COALESCE(tok.priced_rows, 0) AS priced_rows,
         COALESCE(tok.token_usage_rows, 0) AS token_usage_rows,
         tok.cost_source AS token_cost_source,
         ${webSearchCostSql("src.metadata")} AS web_search_cost_usd
       FROM sessions src
       LEFT JOIN (
         SELECT
           session_id,
           COALESCE(SUM(cost_usd_estimated), 0) AS cost_usd,
           COUNT(cost_usd_estimated) AS priced_rows,
           COUNT(*) AS token_usage_rows,
           ${costSourcePrecedenceSql(precedenceFirstParam)} AS cost_source
         FROM token_usage
         WHERE session_id IN (${idPlaceholders})
         GROUP BY session_id
       ) tok ON tok.session_id = src.id
       WHERE src.id IN (${idPlaceholders})
     ) AS agg
     WHERE sessions.id = agg.session_id${pricedTokenUsageGuard}`,
    ...params
  );
}

/**
 * ISS-7776: options for {@link updateSessionCostRollupBatch}.
 */
export type SessionCostRollupBatchOptions = {
  /**
   * Only write a session whose `token_usage` rows are ALL priced, leaving every
   * partially- or un-priced session's stored total untouched. Zero rows
   * satisfies it — that is a real priceable state (a web-search-only session),
   * not a gap.
   *
   * A partial sum is not a total. `SUM` skips NULLs and nothing records that it
   * did, so `Σ(priced) + web` on a half-priced session is a confident dollar
   * figure that is simply low — and stamping it here has a second cost: the read
   * path (`attachEstimatedCosts`) re-prices from `token_usage` ONLY while this
   * column is NULL, so filling it with an under-report also suppresses the
   * repair. Leaving it alone keeps "unknown" honest and keeps that repair live.
   *
   * DECLINE, NOT CLEAR, and that is the landed contract rather than an oversight
   * (`write-core-import-phases.test.ts`, ISS-7578/7776): "a stale real number
   * beats a fresh wrong one". #5825 review (whitlockk) argued for NULLing instead,
   * because a survivor is served verbatim by `attachEstimatedCosts` and so also
   * suppresses the read-path repair. That trade is real, but it is the OPPOSITE
   * of what the import phase already ships — `importPhaseDerivedRollups`
   * deliberately skips the per-session rollup in exactly these states and
   * REPORTS the skip (`session_cost_rollup …: skipped, N of M token_usage rows
   * priced`), so the state is not silent, and flipping the column to NULL here
   * would make this batch overrule that phase's decision two statements later.
   * Changing "stale beats wrong" to "unknown beats stale" is a contract change
   * across both writers and their tests; it belongs to its own ticket, not to
   * the convergence refactor that merely MOVED this function.
   *
   * `updateSessionCostRollup` and the unguarded form of this batch deliberately
   * DO write in those states: they run immediately after pricing, where an
   * unpriced row means pricing genuinely failed and their answer is the current
   * best evidence. This option is for callers that run LATER, over rows they did
   * not price and cannot distinguish "failed" from "not yet".
   */
  requireFullyPricedTokenUsage?: boolean;
};

/**
 * ISS-7762: the `cost_source` stamp for a priced row — the SINGLE place that
 * decides it, so `token_usage` and `token_events` can never disagree about the
 * provenance of the same estimate.
 *
 * `GenaiPricesV1` asserts the price library confirmed the rate. When
 * `computeHarnessCost` fell back to `UNKNOWN_MODEL_FALLBACK_TIER` it did not —
 * genai-prices had no entry for the model id — so that row is stamped
 * `FallbackTierV1` instead. Both are priced and both carry an exact cost; they
 * differ only in whether the RATE is verified, which is precisely what a reader
 * asking "can I trust this number" needs to know.
 *
 * Scope: the PER-ROW stamp on `token_usage` / `token_events`. The session-level
 * rollup has one branch this does not cover — a web-search-only session — which
 * still stamps `genai_prices_v1` for a hardcoded rate; see the note at that
 * branch in `updateSessionCostRollup`.
 */
function pricingSourceForEstimate(
  estimate: EstimateTokenCostResult | undefined
): ModelPricingSource | null {
  if (!estimate) {
    return null;
  }
  return estimate.unknownModelFallbackApplied
    ? ModelPricingSource.FallbackTierV1
    : ModelPricingSource.GenaiPricesV1;
}

const TOKEN_EVENT_COST_SET_SQL = `cost_usd_estimated = $1,
       input_cost_usd_estimated = $2,
       output_cost_usd_estimated = $3,
       cache_read_cost_usd_estimated = $4,
       cache_creation_cost_usd_estimated = $5,
       cost_currency = $6,
       cost_source = $7,
       cost_observed_at = $8`;

/**
 * ISS-8060: {@link updateTokenEventCost}'s two locators, one per identity kind.
 *
 * They are two statements rather than the one `OR` they replace because the
 * desktop store is never `ANALYZE`d: with no stats SQLite cannot prove either OR
 * arm selective, falls back to `idx_token_events_session (session_id=?)`, and
 * rescans EVERY row of the session for each of the N per-event updates. Measured
 * on the production import path, the `token_events` group went 1,975ms → 7,317ms
 * as one session's events went 4,000 → 8,000. The arms are mutually exclusive on
 * `event.transportId` — the same test `costSummary` already makes — so which row
 * a call matches is unchanged. `token-event-cost-locator.test.ts` EXPLAINs
 * whichever of these `updateTokenEventCost` actually issued, captured from the
 * call — EXPLAINing the constant would still pass if the function stopped using it.
 */
const TOKEN_EVENT_COST_TRANSPORT_UPDATE_SQL = `UPDATE token_events SET ${TOKEN_EVENT_COST_SET_SQL},
       cost_summary = $9
     WHERE session_id = $10 AND transport_id = $11`;

/**
 * The pre-transport locator. `cost_summary` is deliberately absent from the SET,
 * preserving the stored summary exactly as the `CASE WHEN transport_id IS NULL`
 * arm this replaces did — a legacy record carries no summary to write.
 */
const TOKEN_EVENT_COST_LEGACY_UPDATE_SQL = `UPDATE token_events SET ${TOKEN_EVENT_COST_SET_SQL}
     WHERE session_id = $9
       AND transport_id IS NULL
       AND model = $10
       AND created_at = $11
       AND input_tokens = $12
       AND output_tokens = $13
       AND cache_read_tokens = $14
       AND cache_write_tokens = $15
       AND cache_write_5m_tokens IS $16
       AND cache_write_1h_tokens IS $17`;

/**
 * ISS-7820: what "this session's `token_usage` window is FULLY priced" means, in
 * one place, because two writers now branch on it and a drifted copy would make a
 * session's cost depend on which of them touched it last — the same reason
 * {@link webSearchCostSql} and {@link costSourcePrecedenceSql} are shared.
 *
 * `priced_rows` is `COUNT(cost_usd_estimated)` (non-NULL only) and
 * `token_usage_rows` is `COUNT(*)`, so equality means every row carries a price.
 * ZERO ROWS SATISFIES IT, deliberately: a session with no `token_usage` at all is
 * not half-priced, it simply has no token spend, and a web-search-only session is
 * a real priceable state. Whether that session has a cost to report is the
 * SEPARATE `priced_rows > 0 OR web_search > 0` question each caller asks next.
 *
 * The two callers do different things with the answer, and that difference is
 * intentional. {@link updateSessionCostRollupBatch} puts it in the outer WHERE and
 * DECLINES the write (the landed "a stale real number beats a fresh wrong one"
 * contract — see {@link SessionCostRollupBatchOptions.requireFullyPricedTokenUsage}).
 * The `session_analytics.est_cost` rollup has nothing stale to keep — it is
 * recomputed whole on every pass — so it writes NULL and says "unknown".
 */
export function fullyPricedTokenUsageSql(
  pricedRowsExpr: string,
  tokenUsageRowsExpr: string
): string {
  return `${pricedRowsExpr} = ${tokenUsageRowsExpr}`;
}

/**
 * ISS-7820: a session's whole-cost total, or NULL when it is not knowable — the
 * ONE expression both stored session totals are computed from.
 *
 * Three outcomes, and the middle one is the whole point of the ticket:
 *   · not fully priced  -> NULL. `SUM` skips NULLs and records nothing, so
 *     `Σ(priced) + web` on a half-priced window is a confident dollar figure
 *     that is simply low, and on an all-unpriced one it is the web-search line
 *     item ALONE (measured at $0.03 for a session that cost $0.04753625).
 *   · fully priced with evidence (a priced row, or a web-search line item)
 *     -> the total, which is what it always was.
 *   · fully priced with NO evidence at all (no `token_usage` rows, no web
 *     search) -> NULL, matching `sessions.cost_usd_estimated` exactly. Nothing
 *     was measured, so there is nothing to report; a session whose rows ARE all
 *     priced and sum to $0.00 still reports 0, which is what keeps a real
 *     zero distinguishable from an absent one.
 */
export function sessionEstimatedCostSql(parts: {
  tokenCostUsdExpr: string;
  pricedRowsExpr: string;
  tokenUsageRowsExpr: string;
  webSearchCostUsdExpr: string;
}): string {
  return `CASE
       WHEN NOT (${fullyPricedTokenUsageSql(parts.pricedRowsExpr, parts.tokenUsageRowsExpr)}) THEN NULL
       WHEN ${parts.pricedRowsExpr} > 0 OR ${parts.webSearchCostUsdExpr} > 0
         THEN ${parts.tokenCostUsdExpr} + ${parts.webSearchCostUsdExpr}
       ELSE NULL
     END`;
}
