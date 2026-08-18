import {
  BranchCostCompleteness,
  BranchCostCompletenessReason,
  type BranchCostCompletenessResult,
} from "@repo/api/src/types/branch-usage";

/** Cross-surface states that both Branch usage projection adapters must classify identically. */
export const BranchCostParityState = {
  RowCap: "row_cap",
  ByteCap: "byte_cap",
  AggregateOnly: "aggregate_only",
  Malformed: "malformed",
  Unavailable: "unavailable",
} as const;

export type BranchCostParityState =
  (typeof BranchCostParityState)[keyof typeof BranchCostParityState];

export type BranchCostParityEvent = {
  inputTokens: number;
  costUsd: number | null;
};

export type BranchCostParityCase = {
  name: string;
  state: BranchCostParityState;
  windowActive: boolean;
  evidenceExceeded: boolean;
  lifetimeInputTokens: number;
  lifetimeCostUsd: number;
  events: readonly BranchCostParityEvent[];
  expected: BranchCostCompletenessResult;
};

/**
 * One provider-neutral scenario set consumed by both the cloud and Desktop
 * projection tests. Reader-specific tests separately prove the physical cap
 * boundary; these cases prove the resulting surface contract cannot drift.
 */
export const BRANCH_COST_COMPLETENESS_PARITY_CASES: readonly BranchCostParityCase[] =
  [
    {
      name: "row-cap fallback",
      state: BranchCostParityState.RowCap,
      windowActive: false,
      evidenceExceeded: true,
      lifetimeInputTokens: 1,
      lifetimeCostUsd: 3,
      events: [{ inputTokens: 1, costUsd: 3 }],
      expected: {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.CoverageIncomplete,
        subtotalUsd: 3,
      },
    },
    {
      name: "byte-cap fallback",
      state: BranchCostParityState.ByteCap,
      windowActive: false,
      evidenceExceeded: true,
      lifetimeInputTokens: 1,
      lifetimeCostUsd: 3,
      events: [{ inputTokens: 1, costUsd: 3 }],
      expected: {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.CoverageIncomplete,
        subtotalUsd: 3,
      },
    },
    {
      name: "bounded aggregate-only",
      state: BranchCostParityState.AggregateOnly,
      windowActive: true,
      evidenceExceeded: false,
      lifetimeInputTokens: 1,
      lifetimeCostUsd: 3,
      events: [],
      expected: {
        completeness: BranchCostCompleteness.Complete,
        subtotalUsd: 0,
        lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
      },
    },
    {
      name: "malformed event tokens with valid cost",
      state: BranchCostParityState.Malformed,
      windowActive: true,
      evidenceExceeded: false,
      lifetimeInputTokens: 0,
      lifetimeCostUsd: 3,
      events: [{ inputTokens: -1, costUsd: 3 }],
      expected: {
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.Malformed,
        subtotalUsd: 3,
        lanes: { subscriptionEquivalentCost: 3, apiEstimatedCost: 0 },
      },
    },
    {
      name: "bounded unpriced evidence",
      state: BranchCostParityState.Unavailable,
      windowActive: true,
      evidenceExceeded: false,
      lifetimeInputTokens: 1,
      lifetimeCostUsd: 3,
      events: [{ inputTokens: 1, costUsd: null }],
      expected: {
        completeness: BranchCostCompleteness.Unavailable,
        reason: BranchCostCompletenessReason.PricingIncomplete,
      },
    },
  ];
