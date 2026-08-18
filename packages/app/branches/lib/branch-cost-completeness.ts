import {
  BranchBillingMode,
  type BranchPhase,
} from "@repo/api/src/types/branch";
import {
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
} from "@repo/api/src/types/branch-usage";
import {
  TokenCostBasis,
  TokenCostCompleteness,
} from "@repo/api/src/types/token-cost-provenance";
import {
  computeTokenCost,
  TokenCostNotPricedReason,
} from "@repo/cost/genai-cost";

/** Legacy token row consumed by Branch usage derivations. */
export type BranchTokenRow = {
  sessionId: string;
  owner: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hourStart?: string | null;
  phase?: BranchPhase | null;
  billingMode?: BranchBillingMode | null;
  timestamp?: Date;
};

export type TokenCounts = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp?: Date;
};

/** Create an empty pricing accumulator for one model and historical date. */
export function emptyCounts(model: string, timestamp?: Date): TokenCounts {
  return { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, timestamp };
}

/** Add one valid legacy row to an existing pricing accumulator. */
export function addRow(counts: TokenCounts, row: BranchTokenRow): void {
  counts.input += row.inputTokens;
  counts.output += row.outputTokens;
  counts.cacheRead += row.cacheReadTokens;
  counts.cacheWrite += row.cacheWriteTokens;
}

/** Price accumulated counts through the canonical cross-runtime engine. */
export function priceCounts(counts: TokenCounts) {
  return computeTokenCost({
    model: counts.model,
    inputTokens: counts.input,
    outputTokens: counts.output,
    cacheReadTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
    timestamp: counts.timestamp,
  });
}

/** Adapt legacy rows into conservative, provider-neutral cost evidence. */
export function branchCostContributions(
  rows: readonly BranchTokenRow[]
): BranchCostEvidenceContribution[] {
  const groups = new Map<
    string,
    {
      billingMode: BranchBillingMode | null;
      counts: TokenCounts;
      malformed: boolean;
    }
  >();
  for (const row of rows) {
    const billingMode = row.billingMode ?? null;
    const key = JSON.stringify([row.sessionId, row.model, billingMode]);
    const group = groups.get(key) ?? {
      billingMode,
      counts: emptyCounts(row.model, row.timestamp),
      malformed: false,
    };
    group.malformed ||= hasInvalidTokenCount(row);
    addRow(group.counts, row);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ billingMode, counts, malformed }) => {
    if (malformed) {
      return { reason: BranchCostCompletenessReason.Malformed };
    }
    const result = priceCounts(counts);
    if (result.costUsd === null) {
      return {
        reason:
          result.reason === TokenCostNotPricedReason.InvalidCount
            ? BranchCostCompletenessReason.Malformed
            : BranchCostCompletenessReason.PricingIncomplete,
      };
    }
    const basis = billingModeCostBasis(billingMode);
    return {
      costSummary: {
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: result.costUsd,
        ...(basis ? { lanes: [{ basis, subtotalUsd: result.costUsd }] } : {}),
      },
    };
  });
}

function hasInvalidTokenCount(row: BranchTokenRow): boolean {
  return ![
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
  ].every((count) => Number.isFinite(count) && count >= 0);
}

function billingModeCostBasis(
  billingMode: BranchBillingMode | null
): TokenCostBasis | undefined {
  switch (billingMode) {
    case BranchBillingMode.Subscription:
      return TokenCostBasis.SubscriptionEquivalent;
    case BranchBillingMode.Api:
      return TokenCostBasis.ApiEstimated;
    case null:
      return undefined;
    default: {
      const exhaustive: never = billingMode;
      return exhaustive;
    }
  }
}
