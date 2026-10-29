/**
 * @file write-core-import-phases-rollups.ts
 * @description Record groups 8-8.5: the derived aggregates recomputed from the rows every
 * earlier phase wrote. The derived-rollup phase takes its last-activity
 * recomputation as a callback, keeping the module graph one-way.
 */
import { upsertActivityMetricsRollup } from "./activity-metrics.js";
import type { Prisma } from "./generated/client.js";
import type { ImportSessionContext } from "./import-session-context.js";
import { upsertSessionAnalyticsRollup } from "./session-analytics-rollup.js";
import { rollUpSessionAuthoritativeCost } from "./session-authoritative-cost.js";
import { updateSessionCostRollup } from "./token-cost-writes.js";

/**
 * Record group 8: derived rollups. Recompute this session's ESTIMATED cost
 * total and its analytics rollup (FEA-2038), then refresh the denormalized
 * last_activity_at cursor key. All three read the rows the phases above wrote,
 * so this runs last; all three are recompute-from-source and idempotent.
 *
 * ISS-7776: `sessions.cost_usd_estimated` is recomputed HERE, not only as the last
 * statement of `persistImportedTokenCosts`, because it and
 * `session_analytics.est_cost` are two INDEPENDENT derivations of the same
 * total: each sums `token_usage.cost_usd_estimated` and adds the shared
 * `webSearchCostSql` line item read from `sessions.metadata`. Sharing the SQL
 * fragment makes them price web search identically; it does NOT make them agree
 * when only one of them re-runs. ISS-7736's zero-model preserve path returns
 * before `persistImportedTokenCosts`, so the metadata refresh landed while the
 * estimate kept a web-search line item the analytics one had already
 * dropped.
 *
 * The invariant this phase provides is therefore narrower than "the two columns
 * can never diverge", because only the analytics rollup below runs
 * unconditionally: when {@link everyTokenUsageRowIsPriced} holds, both totals are
 * recomputed from the same sources in the same phase and CONVERGE — and because
 * both are recompute-from-source, the ordinary path where the cost phase already
 * ran gets the same value back. When it does not hold, the cost recompute is
 * deliberately skipped while the analytics rollup still re-runs, so the two
 * columns may legitimately disagree until the rows are priced: an unpriced
 * population cannot answer "what did this session cost", and a stale real number
 * beats a fresh wrong one (see that predicate for why).
 */
export async function importPhaseDerivedRollups(
  tx: Prisma.TransactionClient,
  ctx: DerivedRollupContext,
  recomputeLastActivityAt: (
    tx: Prisma.TransactionClient,
    sessionId: string
  ) => Promise<void>,
  replaceComponentUsage = true
): Promise<void> {
  const { session, now } = ctx;
  const pricing = await readTokenUsagePricingCounts(tx, session.sessionId);
  if (everyTokenUsageRowIsPriced(pricing)) {
    await updateSessionCostRollup(tx, session.sessionId);
  } else if (pricing.pricedRows > 0) {
    ctx.log(partiallyPricedRollupReport(session.sessionId, pricing));
  }
  // ISS-7229: Claude's OWN reported total.
  //
  // VOCABULARY, because this file now writes two cost columns and one of them is
  // literally named `authoritative_cost_usd`: everything above calls
  // `sessions.cost_usd_estimated` "the estimate", and only this statement writes
  // the authoritative column. They are the two OPERANDS of the estimator-drift
  // delta — different producer, different pricing engine — so summing or
  // coalescing them is the one operation this pair must never undergo. The prose
  // above used to call the ESTIMATE "the authoritative total", which is exactly
  // the conflation that would invite it (marisolashgrove, #6385 review).
  //
  // It runs UNCONDITIONALLY where the estimate above is gated. The gate exists because
  // an unpriced `token_usage` population cannot answer what the session cost;
  // this figure has no pricing step to be incomplete — it sums a capture table
  // Claude wrote — so there is no partially-priced state for it to be wrong
  // about, and skipping it would only strand a session whose OTel events landed
  // before the collector imported its transcript.
  //
  // This is also the ONLY call site that reaches a session with no cost events
  // at all, which is what makes the rollup's bare `SUM` load-bearing rather than
  // decorative: it writes NULL here, where a `COALESCE(..., 0)` would stamp a
  // confident "Claude reported $0.00" on every uncaptured session.
  await rollUpSessionAuthoritativeCost(tx, session.sessionId, now);
  await upsertSessionAnalyticsRollup(tx, session.sessionId, now, {
    replaceComponentUsage,
    log: ctx.log,
  });
  await recomputeLastActivityAt(tx, session.sessionId);
}

/**
 * Record group 8.5: FEA-2273 activity-attribution metrics emission. Deliberately
 * ISOLATED from the analytics rollup (group 8) into its OWN transaction: it is a
 * SECONDARY rollup that additionally reads `token_events`, so keeping it out of
 * the analytics group means a metrics failure (e.g. `token_events` unavailable)
 * can never abort the primary analytics rollup, and its best-effort catch wraps a
 * dedicated metrics-only transaction rather than continuing a shared interactive
 * one. Reads the `session_analytics` row group 8 just wrote (for cohorts).
 */
export async function importPhaseActivityMetrics(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  await upsertActivityMetricsRollup(tx, ctx.session.sessionId, ctx.now);
}

type DerivedRollupContext = Pick<
  ImportSessionContext,
  "session" | "now" | "log"
>;

/** How much of this session's `token_usage` population carries a cost. */
type TokenUsagePricingCounts = {
  usageRows: number;
  pricedRows: number;
};

/** `COUNT(cost_usd_estimated)` counts only non-NULL costs, so it is the priced half. */
async function readTokenUsagePricingCounts(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<TokenUsagePricingCounts> {
  const rows = await tx.$queryRawUnsafe<
    { usage_rows: number | bigint; priced_rows: number | bigint }[]
  >(
    `SELECT COUNT(*) AS usage_rows, COUNT(cost_usd_estimated) AS priced_rows
       FROM token_usage
      WHERE session_id = $1`,
    sessionId
  );
  return {
    usageRows: Number(rows[0]?.usage_rows ?? 0),
    pricedRows: Number(rows[0]?.priced_rows ?? 0),
  };
}

/**
 * Whether this session's `token_usage` rows can produce a trustworthy estimate
 * at all — the precondition every OTHER caller of `updateSessionCostRollup`
 * satisfies by construction, because each of them just priced the rows it is
 * about to sum.
 *
 * This phase is the first caller with no such guarantee. Record group 3
 * re-inserts `token_usage` with NO cost columns and record group 4 is the phase
 * that prices them, but group 4 is TOLERANT in the isolated-import path: a
 * failure there is logged and the import continues to here.
 *
 * The whole population must be priced, not merely part of it. `updateSessionCostRollup`
 * sums the non-NULL rows and persists that sum as the estimate, so a
 * PARTIALLY priced population yields a confident number computed over an
 * incomplete input — the four-model session that lost one model's price reports
 * three models' spend as the session's whole cost, and nothing downstream can
 * tell that total apart from a complete one (`attachEstimatedCosts` re-sums
 * `token_usage` only when the column is NULL, so a present-but-partial total is
 * taken at face value). The all-unpriced case is the same failure at its limit:
 * it answers "this session cost nothing", and with a web-search count present it
 * writes that line item ALONE as the whole total — a $0.03 answer for a $12
 * session. "Not priced yet" is not a cost; leaving the stored total alone keeps
 * it a stale real number rather than a fresh wrong one.
 *
 * A session with no `token_usage` rows at all satisfies this trivially (0 of 0
 * priced) and is a different answer, not a degenerate one: nothing is pending, so
 * a web-search-only or genuinely zero total is correct and must be written.
 */
function everyTokenUsageRowIsPriced(pricing: TokenUsagePricingCounts): boolean {
  return pricing.pricedRows === pricing.usageRows;
}

/**
 * The partially-priced population has no other signal: group 4's own failure is
 * reported by the tolerant import group, but a group that priced SOME rows and
 * then failed leaves a state no phase would otherwise mention, and the skipped
 * recompute is invisible in the stored columns (the total simply stays put).
 * Reported here, where the counts that make it actionable are in scope.
 */
function partiallyPricedRollupReport(
  sessionId: string,
  pricing: TokenUsagePricingCounts
): string {
  return `session_cost_rollup ${sessionId}: skipped, ${pricing.pricedRows} of ${pricing.usageRows} token_usage rows priced; the stored total is left stale rather than recomputed from a partially priced population`;
}
