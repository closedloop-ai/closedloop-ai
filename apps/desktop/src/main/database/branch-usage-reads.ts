/**
 * @file branch-usage-reads.ts
 * @description Branch-linked aggregate and event usage reads extracted from
 * the oversized Branch read facade while preserving its public API.
 */
import { resolveBillingMode } from "../cost/billing-mode-detector.js";
import type { BranchUsageTokenRow } from "./branch-reads.js";
import { branchUsageEventFingerprintSql } from "./branch-usage-event-fingerprint.js";
import {
  type BranchUsageEventWindowBounds,
  branchUsageEventWindowSql,
} from "./branch-usage-event-window-sql.js";
import {
  mapBranchUsageCacheWriteTiers,
  mapBranchUsageTokenCounts,
} from "./branch-usage-token-counts.js";
import type { DbHostPrisma } from "./prisma-client.js";

/** Return a token expression as TEXT so libSQL cannot overflow before mapping. */
function branchTokenColumnTextSql(
  tokenExpr: string,
  baselineExpr?: string
): string {
  if (baselineExpr) {
    return `CAST(COALESCE(${tokenExpr}, 0) + COALESCE(${baselineExpr}, 0) AS TEXT)`;
  }
  return `CAST(${tokenExpr} AS TEXT)`;
}

/** Raw token-usage row shape shared by both raw SQL reads below. */
type TokenUsageRawRow = {
  session_id: string;
  model: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cache_write_5m_tokens: string | null;
  cache_write_1h_tokens: string | null;
  created_at: string | null;
  session_started_at: string | null;
  cost_usd_estimated: number | null;
};

/**
 * Resolve a branch-joined session row's billing mode the SAME way every Sessions
 * path does (`resolveBillingModeForRow` → `resolveBillingMode`): a stored,
 * definite mode wins, and a missing/legacy/"unknown" one falls back to live
 * detection.
 *
 * Reading `s.billing_mode` verbatim here is what let the two surfaces disagree
 * (ISS-4869 review): after the Keychain detector landed, a historical row stored
 * as 'unknown' resolved to `subscription_unknown` in Sessions while Branches
 * still bucketed the same spend as unclassified. Detection is memoized behind a
 * TTL, so calling it per row costs no extra subprocess.
 */
function resolveBranchRowBillingMode(row: {
  billing_mode: string | null;
  harness: string | null;
}): string {
  return resolveBillingMode({
    billingMode: row.billing_mode,
    harness: row.harness,
  });
}

function mapTokenUsageRawRow(
  row: TokenUsageRawRow,
  billingMode: string | null
): BranchUsageTokenRow {
  return {
    sessionId: row.session_id,
    model: row.model,
    ...mapBranchUsageTokenCounts(row, "branch_usage"),
    ...mapBranchUsageCacheWriteTiers(row, "branch_usage"),
    billingMode,
    createdAt: row.created_at,
    sessionStartedAt: row.session_started_at,
    costUsdEstimated:
      row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated),
  };
}

/**
 * One token row per `(session, model)` for every session linked to a branch,
 * counted once. Resolves the branch-linked session set AND billing mode via a
 * single raw SQL JOIN — no `IN (…)` clause, so there is no SQLite parameter
 * limit (FEA-2260). The `sessions` JOIN carries `billing_mode` AND `harness` for
 * the usage summary's subscription/API billing split — both are needed because
 * the mode is re-resolved through `resolveBranchRowBillingMode`, never read as
 * the raw column, so Branches and Sessions bucket the same spend identically.
 */
export function readBranchUsageTokenRows(
  prisma: DbHostPrisma,
  branchLinkedSessionSubquery: string
): Promise<BranchUsageTokenRow[]> {
  return prisma.client
    .$queryRawUnsafe<
      (TokenUsageRawRow & {
        billing_mode: string | null;
        harness: string | null;
      })[]
    >(
      `SELECT
         tu.session_id,
         tu.model,
         ${branchTokenColumnTextSql("tu.input_tokens", "tu.baseline_input")} AS input_tokens,
         ${branchTokenColumnTextSql("tu.output_tokens", "tu.baseline_output")} AS output_tokens,
         ${branchTokenColumnTextSql("tu.cache_read_tokens", "tu.baseline_cache_read")} AS cache_read_tokens,
         ${branchTokenColumnTextSql("tu.cache_write_tokens", "tu.baseline_cache_write")} AS cache_write_tokens,
         ${branchTokenColumnTextSql("tu.cache_write_5m_tokens")} AS cache_write_5m_tokens,
         ${branchTokenColumnTextSql("tu.cache_write_1h_tokens")} AS cache_write_1h_tokens,
         s.billing_mode,
         s.harness,
         tu.created_at,
         s.started_at AS session_started_at,
         tu.cost_usd_estimated
       FROM token_usage tu
       JOIN sessions s ON s.id = tu.session_id
       WHERE tu.session_id IN (${branchLinkedSessionSubquery})
       ORDER BY tu.session_id ASC, tu.model ASC`
    )
    .then((rows) =>
      rows.map((row) =>
        mapTokenUsageRawRow(row, resolveBranchRowBillingMode(row))
      )
    );
}

/**
 * Per-`(session, model)` token rows for branch-linked sessions, without billing
 * mode (analytics path). Resolves the session set via a SQL subquery JOIN —
 * no `IN (…)` clause, so there is no SQLite parameter limit (FEA-2260).
 * Billing mode is NOT resolved — the rows carry `billingMode: null`; callers
 * that need the subscription/API split must use `readBranchUsageTokenRows`.
 */
export function readBranchAnalyticsTokenRows(
  prisma: DbHostPrisma,
  branchLinkedSessionSubquery: string
): Promise<BranchUsageTokenRow[]> {
  return prisma.client
    .$queryRawUnsafe<TokenUsageRawRow[]>(
      `SELECT
         tu.session_id,
         tu.model,
         ${branchTokenColumnTextSql("tu.input_tokens", "tu.baseline_input")} AS input_tokens,
         ${branchTokenColumnTextSql("tu.output_tokens", "tu.baseline_output")} AS output_tokens,
         ${branchTokenColumnTextSql("tu.cache_read_tokens", "tu.baseline_cache_read")} AS cache_read_tokens,
         ${branchTokenColumnTextSql("tu.cache_write_tokens", "tu.baseline_cache_write")} AS cache_write_tokens,
         ${branchTokenColumnTextSql("tu.cache_write_5m_tokens")} AS cache_write_5m_tokens,
         ${branchTokenColumnTextSql("tu.cache_write_1h_tokens")} AS cache_write_1h_tokens,
         tu.created_at,
         s.started_at AS session_started_at,
         tu.cost_usd_estimated
       FROM token_usage tu
       JOIN sessions s ON s.id = tu.session_id
       WHERE tu.session_id IN (${branchLinkedSessionSubquery})
       ORDER BY tu.session_id ASC, tu.model ASC`
    )
    .then((rows) => rows.map((row) => mapTokenUsageRawRow(row, null)));
}

/**
 * Read per-event spend and provenance for branch-linked sessions. Event time
 * drives bounded totals; aggregate rows remain the all-time legacy fallback.
 *
 * `bounds` (ISS-4941) pushes the caller's active date window onto `created_at`
 * so only the in-window slice is hydrated; omit it for the all-time read.
 */
export function readBranchUsageEventRows(
  prisma: DbHostPrisma,
  branchLinkedSessionSubquery: string,
  bounds?: BranchUsageEventWindowBounds
): Promise<BranchUsageTokenRow[]> {
  const params: unknown[] = [];
  const windowClause = branchUsageEventWindowSql(bounds, params);
  return prisma.client
    .$queryRawUnsafe<
      {
        event_row_id: string;
        event_fingerprint: string;
        session_id: string;
        model: string;
        input_tokens: string | null;
        output_tokens: string | null;
        cache_read_tokens: string | null;
        cache_write_tokens: string | null;
        cache_write_5m_tokens: string | null;
        cache_write_1h_tokens: string | null;
        billing_mode: string | null;
        harness: string | null;
        created_at: string | null;
        session_started_at: string | null;
        cost_usd_estimated: number | null;
      }[]
    >(
      `SELECT
         CAST(te.rowid AS TEXT) AS event_row_id,
         ${branchUsageEventFingerprintSql("te")} AS event_fingerprint,
         te.session_id AS session_id,
         te.model AS model,
         ${branchTokenColumnTextSql("COALESCE(te.input_tokens, 0)")} AS input_tokens,
         ${branchTokenColumnTextSql("COALESCE(te.output_tokens, 0)")} AS output_tokens,
         ${branchTokenColumnTextSql("COALESCE(te.cache_read_tokens, 0)")} AS cache_read_tokens,
         ${branchTokenColumnTextSql("COALESCE(te.cache_write_tokens, 0)")} AS cache_write_tokens,
         ${branchTokenColumnTextSql("te.cache_write_5m_tokens")} AS cache_write_5m_tokens,
         ${branchTokenColumnTextSql("te.cache_write_1h_tokens")} AS cache_write_1h_tokens,
         s.billing_mode AS billing_mode,
         s.harness AS harness,
         te.created_at AS created_at,
         s.started_at AS session_started_at,
         te.cost_usd_estimated AS cost_usd_estimated
       FROM token_events te
       JOIN sessions s ON s.id = te.session_id
       WHERE te.session_id IN (${branchLinkedSessionSubquery})
         ${windowClause}
       ORDER BY te.session_id ASC, te.created_at ASC`,
      ...params
    )
    .then((rows) =>
      rows.map((row) => ({
        eventRowId: row.event_row_id,
        eventFingerprint: row.event_fingerprint,
        sessionId: row.session_id,
        model: row.model,
        ...mapBranchUsageTokenCounts(row, "branch_event"),
        ...mapBranchUsageCacheWriteTiers(row, "branch_event"),
        billingMode: resolveBranchRowBillingMode(row),
        createdAt: row.created_at,
        sessionStartedAt: row.session_started_at ?? null,
        // FEA-4270: the per-event captured cost, so a windowed spend read that
        // sums in-window events reconciles with the dashboard. `null` for events
        // the pricing pipeline never costed (subscription / un-priced models) —
        // treated as $0 by branch spend, same as the aggregate read.
        costUsdEstimated:
          row.cost_usd_estimated == null
            ? null
            : Number(row.cost_usd_estimated),
      }))
    );
}
