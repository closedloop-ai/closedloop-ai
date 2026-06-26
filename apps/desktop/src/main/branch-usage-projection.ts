import {
  type BranchUsageActorBucket,
  type BranchUsageHourBucket,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BillingMode,
  isMeteredApi,
  isSubscription,
} from "../shared/billing-mode.js";
import { estimateTokenCost } from "../shared/token-cost.js";
import { reportTokenCostPricingMiss } from "./token-cost-pricing-miss.js";
import { addStorageTokenCounts } from "./token-counts.js";

/**
 * Desktop main-side branch usage/cost projection (FEA-1948 / Epic B B1).
 *
 * The surface-agnostic projector `@repo/app/branches/lib/branch-derivations`
 * CANNOT be imported here: `@repo/app` is a bundler-resolution package with no
 * `exports`/types entry, and the desktop MAIN process compiles under `nodenext`,
 * which cannot resolve it (TS2307) — the same nodenext-vs-bundler split that
 * governs the whole desktop main boundary. So main keeps its own thin
 * projection. Crucially, pricing is not reimplemented: every USD figure goes
 * through the desktop token-cost compatibility wrapper; only the trivial token
 * summing + grouping is local.
 *
 * Owner/actor has no v1 producer, so callers pass `owner: null` and `byActor`
 * collapses to a single unattributed bucket; phase has no producer, so
 * `phaseStacks` is empty.
 */

export type BranchUsageRow = {
  owner: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billingMode: BillingMode;
  timestamp?: Date;
  /**
   * Captured per-row cost (`token_usage.cost_usd_estimated`), or `null` when the
   * row was never priced. The branch cost surface SUMS this (via
   * `sumStoredBranchCost`) instead of re-deriving list price, so it reconciles
   * with the agent dashboard. Absent (`undefined`) on event-sourced rows, which
   * keep re-deriving for the hourly chart.
   */
  storedCostUsd?: number | null;
};

type TokenSums = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function sumTokens(rows: BranchUsageRow[]): TokenSums {
  return rows.reduce<TokenSums>(
    (acc, row) => {
      acc.inputTokens = addStorageTokenCounts(
        acc.inputTokens,
        row.inputTokens,
        "branch_usage.input_tokens"
      );
      acc.outputTokens = addStorageTokenCounts(
        acc.outputTokens,
        row.outputTokens,
        "branch_usage.output_tokens"
      );
      acc.cacheReadTokens = addStorageTokenCounts(
        acc.cacheReadTokens,
        row.cacheReadTokens,
        "branch_usage.cache_read_tokens"
      );
      acc.cacheWriteTokens = addStorageTokenCounts(
        acc.cacheWriteTokens,
        row.cacheWriteTokens,
        "branch_usage.cache_write_tokens"
      );
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
  );
}

/**
 * Price rows by grouping per model and summing the priced costs. Returns `null`
 * when NOTHING priced — so callers render "—"/gated rather than a misleading 0
 * (matches `costPerBranch`).
 */
export function priceBranchRows(rows: BranchUsageRow[]): number | null {
  const byModel = new Map<string, BranchUsageRow[]>();
  for (const row of rows) {
    const list = byModel.get(row.model) ?? [];
    list.push(row);
    byModel.set(row.model, list);
  }

  let total = 0;
  let anyPriced = false;
  for (const [model, modelRows] of byModel) {
    const sums = sumTokens(modelRows);
    const costInput = {
      model,
      inputTokens: sums.inputTokens,
      outputTokens: sums.outputTokens,
      cacheReadTokens: sums.cacheReadTokens,
      cacheWriteTokens: sums.cacheWriteTokens,
      observedAt: modelRows[0]?.timestamp,
    };
    const estimate = estimateTokenCost(costInput);
    if (estimate) {
      total += estimate.costUsd;
      anyPriced = true;
    } else {
      reportTokenCostPricingMiss(costInput, "branch_projection");
    }
  }
  return anyPriced ? total : null;
}

/**
 * Sum the CAPTURED per-row cost (`storedCostUsd`) — the agent dashboard's basis.
 * Rows the pricing pipeline never costed (`null`/`undefined`) count as $0 (NOT
 * re-derived to list price), so subscription / un-priced usage doesn't inflate
 * branch spend. Returns `null` when NOTHING in the set carries a captured cost,
 * so callers render "—"/gated rather than a misleading 0 — matching
 * `priceBranchRows`' contract for the re-derived path.
 */
export function sumStoredBranchCost(rows: BranchUsageRow[]): number | null {
  let total = 0;
  let anyPriced = false;
  for (const row of rows) {
    if (row.storedCostUsd == null) {
      continue;
    }
    total += row.storedCostUsd;
    anyPriced = true;
  }
  return anyPriced ? total : null;
}

/** Nulls (unattributed) sort last, then alphabetical. */
function compareOwner(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  return a < b ? -1 : 1;
}

/**
 * Per-actor token + cost rollup; `null` owner is its own bucket. `costOf`
 * defaults to the CAPTURED-cost sum (dashboard basis) for the aggregate byActor
 * totals; the event-sourced hour buckets pass `priceBranchRows` since
 * token_events carry no captured cost.
 */
function rollupActors(
  rows: BranchUsageRow[],
  costOf: (rows: BranchUsageRow[]) => number | null = sumStoredBranchCost
): BranchUsageActorBucket[] {
  const byOwner = new Map<string | null, BranchUsageRow[]>();
  for (const row of rows) {
    const list = byOwner.get(row.owner) ?? [];
    list.push(row);
    byOwner.set(row.owner, list);
  }
  return [...byOwner.entries()]
    .sort(([a], [b]) => compareOwner(a, b))
    .map(([owner, ownerRows]) => {
      const sums = sumTokens(ownerRows);
      return {
        owner,
        inputTokens: sums.inputTokens,
        outputTokens: sums.outputTokens,
        cacheReadTokens: sums.cacheReadTokens,
        cacheWriteTokens: sums.cacheWriteTokens,
        estimatedCostUsd: costOf(ownerRows) ?? 0,
      };
    });
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Truncate an instant to the start of its UTC hour, as an ISO string. */
function truncateToUtcHour(timestamp: Date): string {
  const hour = new Date(timestamp.getTime());
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

function perHourBuckets(rows: BranchUsageRow[]): BranchUsageHourBucket[] {
  const byHour = new Map<string, BranchUsageRow[]>();
  for (const row of rows) {
    if (!row.timestamp) {
      continue;
    }
    const hourStart = truncateToUtcHour(row.timestamp);
    const list = byHour.get(hourStart) ?? [];
    list.push(row);
    byHour.set(hourStart, list);
  }
  return [...byHour.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([hourStart, hourRows]) => ({
      hourStart,
      // Event rows carry no captured cost, so the hourly chart re-derives.
      byActor: rollupActors(hourRows, priceBranchRows),
    }));
}

/**
 * Project branch-linked token rows into the canonical `BranchUsageSummary`.
 * Token totals are plain sums; the headline/total + billing-split USD figures sum
 * the CAPTURED per-row cost (`sumStoredBranchCost`) so they reconcile with the
 * agent dashboard — un-priced rows count as $0, never re-derived to list price.
 * Only the event-sourced hourly chart re-derives (its rows carry no captured
 * cost). `phaseStacks` is empty (no phase producer in v1).
 *
 * The subscription/api cost split follows the canonical billing ledger
 * (FEA-1434, `shared/billing-mode`): metered per-token modes (`api`,
 * `cursor_api`) feed the api bucket; flat subscription/seat modes (`pro`,
 * `subscription_unknown`, `codex_subscription`, `cursor_pro`, …) feed the
 * subscription bucket. Unknown/opencode rows count toward neither sub-bucket but
 * still toward the total — mirroring `headlineCost = metered + unknown`.
 *
 * `hourRows` defaults to `rows`, but callers pass per-EVENT rows (real
 * timestamps) so the hourly buckets aren't collapsed onto a single aggregate
 * `created_at` (see `readBranchUsageEventRows`).
 */
export function projectBranchUsage(
  rows: BranchUsageRow[],
  branchCount: number,
  hourRows: BranchUsageRow[] = rows
): BranchUsageSummary {
  const totals = sumTokens(rows);
  const subscriptionRows = rows.filter((row) =>
    isSubscription(row.billingMode)
  );
  const apiRows = rows.filter((row) => isMeteredApi(row.billingMode));
  return {
    viewerScope: BranchViewerScope.Self,
    totalBranches: branchCount,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    totalEstimatedCost: sumStoredBranchCost(rows) ?? 0,
    subscriptionEstimatedCost: sumStoredBranchCost(subscriptionRows) ?? 0,
    apiEstimatedCost: sumStoredBranchCost(apiRows) ?? 0,
    hourBuckets: perHourBuckets(hourRows),
    phaseStacks: [],
    byActor: rollupActors(rows),
  };
}
