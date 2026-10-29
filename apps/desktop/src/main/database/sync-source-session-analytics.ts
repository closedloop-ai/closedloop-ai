/**
 * @file sync-source-session-analytics.ts
 * @description The `session_analytics` → synced-payload mapper, extracted from
 * `sync-source.ts` (ISS-7176) to keep that grandfathered file shrinking rather
 * than growing. Pure LEAF: a row shape in, a payload shape out, no I/O.
 */
import type { SyncedAgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { MAX_SESSION_ESTIMATED_COST_USD } from "@repo/cost/session-web-search-cost";
import { tokenCountValue } from "./db-helpers.js";
import type {
  SqliteSessionAnalyticsRow,
  SqliteTokenUsageRow,
} from "./db-row-types.js";

/**
 * FEA-2730 (G10): map the desktop `session_analytics` rollup row to the synced
 * shape. Returns undefined when the session has no rollup so the payload omits
 * the section (and the cloud preserves any previously synced rollup). Token
 * counts go through `tokenCountValue` for BigInt-safe carry; `is_human` (0/1)
 * becomes a boolean.
 */
export function mapSyncedSessionAnalytics(
  row: SqliteSessionAnalyticsRow | undefined,
  /**
   * ISS-7813: the whole-session cost, passed in rather than read off `row` so the
   * SOURCE is the caller's decision.
   *
   * The value this wants is the validated result of
   * `resolveSyncedSessionCostUsd`: the current `session_analytics.est_cost`
   * first, then `sessions.cost_usd_estimated` (written by
   * `updateSessionCostRollup`) only when the token window is fully priced. The
   * two carry the same figure whenever a cost is known — both sum
   * `token_usage.cost_usd_estimated` and add the same `webSearchCostSql` line
   * item.
   *
   * ISS-7820 closed the gap that used to make `est_cost` strictly lossy: it is
   * nullable now and computed from the SAME `sessionEstimatedCostSql` as the
   * authoritative column, so it can say "unknown" too. What still differs is
   * what each does in the unknown state — `est_cost` is recomputed whole and
   * goes NULL, while the authoritative column is left on whatever its last write
   * put there — so the caller still has a source decision to make, and it still
   * ends at `sessions.cost_usd_estimated`.
   *
   * This is why the caller passes a VALIDATED chain, built by
   * {@link resolveSyncedSessionCostUsd}, rather than the bare `?? 0` that used
   * to be dead code. That helper's docstring owns why each link is where it is
   * and what each candidate must prove before it is trusted — including why
   * "whatever its last write put there" is not always a total worth sending.
   *
   * `null` is therefore a VALUE here, not an absence, and this signature admits
   * it so the cloud contract and this mapper agree. ISS-7818 completed that
   * producer flip after the nullable cloud column shipped: an analytics section
   * with an unknown cost now carries an explicit `null` to the cloud.
   */
  sessionCostUsd: number | null
): SyncedAgentSessionAnalytics | undefined {
  if (!row) {
    return undefined;
  }
  return {
    startedAt: row.started_at,
    startedDay: row.started_day,
    status: row.status,
    harness: row.harness,
    isHuman: row.is_human !== 0,
    humanTurns: row.human_turns,
    agentTurns: row.agent_turns,
    eventCount: row.event_count,
    toolInvocations: row.tool_invocations,
    errorEvents: row.error_events,
    inputTokens: tokenCountValue(row.input_tokens, "analytics.input"),
    outputTokens: tokenCountValue(row.output_tokens, "analytics.output"),
    cacheReadTokens: tokenCountValue(
      row.cache_read_tokens,
      "analytics.cacheRead"
    ),
    cacheWriteTokens: tokenCountValue(
      row.cache_write_tokens,
      "analytics.cacheWrite"
    ),
    // Always emitted, and `null` is a VALUE (unknown), not an omission — the
    // cloud stores it as-is. Omitting instead would fold to 0 on the far side.
    estimatedCostUsd: sessionCostUsd,
    runtimeMs: row.runtime_ms,
    updatedAt: row.updated_at,
  };
}

/**
 * ISS-7820 (review, whitlockk): is this session's `token_usage` window FULLY priced
 * — the TypeScript twin of `fullyPricedTokenUsageSql` (`token-cost-writes.ts`),
 * evaluated over the rows the sync load already holds so nothing new is queried.
 *
 * Same predicate, same edge: `priced_rows = token_usage_rows`, and ZERO ROWS
 * SATISFIES IT, because a session with no token spend is not half-priced. The
 * SQL side counts `COUNT(cost_usd_estimated)` against `COUNT(*)`; a NULL
 * `cost_usd_estimated` here is the same unpriced row that COUNT skips.
 */
function isTokenUsageWindowFullyPriced(
  rows: readonly Pick<SqliteTokenUsageRow, "cost_usd_estimated">[]
): boolean {
  return rows.every((row) => row.cost_usd_estimated != null);
}

/**
 * ISS-7820 (review, whitlockk + davetho): the whole-session cost the payload
 * carries, chosen from the persisted candidates and VALIDATED before any of
 * them is trusted. This is the persisted-to-wire boundary for that number.
 *
 * Validation first, because both candidates are SQLite `REAL` columns with no
 * CHECK constraint behind them, while the receiving contract is
 * `z.number().finite().nonnegative().nullable().optional()`
 * (`desktop-agent-sessions-schema.ts`, whose own comment spells out the blast
 * radius: a bad value here "would fail THIS field, fail its session, and fail
 * `parseDesktopAgentSessionsPayload` for the WHOLE batch"). One corrupt row
 * would therefore cost every session in the batch, on every retry. Same posture
 * `storedEstimatedCost` already takes for the component-invocation cost.
 *
 * Then the order, each link earning its place:
 *   - `est_cost` first, because a valid current analytics rollup already carries
 *     the same whole-session formula as the authoritative column.
 *   - `cost_usd_estimated` second, but ONLY when this session's `token_usage`
 *     window is fully priced. The reach exists so a fresh "unknown" is not
 *     folded straight to a confident $0.00 — but the column is only worth
 *     reaching for while it holds a total the store can stand behind, and it
 *     does not always. `requireFullyPricedTokenUsage` DECLINES the write in the
 *     batch rollup, yet `updateSessionCostRollup` — which `persistImportedTokenCosts`
 *     runs at the end of every import — is deliberately UNGUARDED
 *     (`token-cost-writes.ts`, `SessionCostRollupBatchOptions` docstring), so a
 *     mixed import leaves the PARTIAL sum there. Sending that is a confident
 *     number that is simply low, which is the exact defect this ticket exists to
 *     remove. Unpriced window, no reach.
 *   - `null` last, because neither persisted candidate can support a number.
 *     The nullable ingress and column shipped with ISS-7813 before this producer
 *     flip, so unknown reaches the cloud without being fabricated as `$0.00`.
 */
export function resolveSyncedSessionCostUsd(
  analyticsEstCostUsd: number | null | undefined,
  authoritativeCostUsd: number | null | undefined,
  tokenUsageRows: readonly Pick<SqliteTokenUsageRow, "cost_usd_estimated">[]
): number | null {
  const analyticsCostUsd = syncableCostUsd(analyticsEstCostUsd);
  if (analyticsCostUsd !== undefined) {
    return analyticsCostUsd;
  }
  if (!isTokenUsageWindowFullyPriced(tokenUsageRows)) {
    return null;
  }
  return syncableCostUsd(authoritativeCostUsd) ?? null;
}

/**
 * The scale the cloud rounds this figure to on the way into `Decimal(14, 6)`
 * (`roundCost`, `apps/api/app/agent-sessions/service/coercion.ts`).
 */
const SYNCED_SESSION_COST_USD_SCALE = 6;

/**
 * A persisted cost the wire contract AND its destination column would accept, or
 * `undefined`.
 *
 * ISS-7818 review (whitlockk): two runtime lies this has to survive, neither of which
 * the parameter type can stop. Both candidates are SQLite `REAL` columns, and
 * affinity lets a non-numeric value be stored in one anyway, so this is a real
 * trust boundary rather than a type-forbidden branch.
 *
 *   - The `typeof` gate comes BEFORE the range check because `Number("")` is `0`.
 *     A blank cell would otherwise serialize as a confident $0.00 — the exact
 *     fabricated zero this ticket exists to remove, arriving by the one path that
 *     looks validated.
 *   - The ceiling exists because the SESSION-analytics ingress schema
 *     (`z.number().finite().nonnegative()`, `desktop-agent-sessions-schema.ts`)
 *     has no upper bound: a corrupt $100,000,000 clears it, then overflows
 *     `Decimal(14, 6)` on write and rolls back the whole session sync. Unknown
 *     must degrade to `null`, never to a failed ingest of every other session in
 *     the batch.
 *   - ISS-9076 added `mapSyncedTokenEvent` as a second caller, where the same
 *     ceiling buys the opposite thing: that field's ingress DOES bound it
 *     (`.refine(isPersistableTokenCost)`, `desktop-agent-sessions-token-schema.ts`),
 *     so an over-ceiling value fails `safeParse` and 400s the whole batch of up
 *     to 200 sessions rather than one row. Dropping it here keeps that batch
 *     ingestible.
 *
 * The ceiling is checked against the CANONICALIZED figure — the same one the
 * cloud's `roundCost` will store — so the check and the write agree on a single
 * number instead of on two that differ in the seventh decimal place.
 */
export function syncableCostUsd(
  value: number | null | undefined
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const canonical = Number(value.toFixed(SYNCED_SESSION_COST_USD_SCALE));
  return canonical <= MAX_SESSION_ESTIMATED_COST_USD ? canonical : undefined;
}
