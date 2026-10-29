import {
  type BranchPrototypeListMetricBundle,
  BranchPrototypeMetricComparisonLabel,
  type BranchPrototypeMetricEvidence,
  BranchPrototypeMetricPeriod,
} from "@repo/lib/branches/branch-prototype-metric-adapter";
import type { BranchPublicationLocSource } from "@repo/lib/branches/branch-publication-loc";

export const CostPhase = {
  Build: "build",
  Review: "review",
  Rework: "rework",
} as const;
export type CostPhase = (typeof CostPhase)[keyof typeof CostPhase];

export const ComparisonLabel = BranchPrototypeMetricComparisonLabel;
export type ComparisonLabel = BranchPrototypeMetricComparisonLabel;

export const MetricPeriod = BranchPrototypeMetricPeriod;
export type MetricPeriod = BranchPrototypeMetricPeriod;

export type BranchMetricBundle = BranchPrototypeListMetricBundle;

/**
 * The adapter's own snapshot shape. `priorActiveByRange` is keyed by metric
 * PERIOD, not by the toolbar's `DateRange`, so a new period reaches the fixture
 * through the canonical union instead of a second hand-maintained key set.
 */
export type StatusSnapshot =
  BranchPrototypeMetricEvidence["statusSnapshots"][number];

export type LocContribution = {
  sourceEventId: string;
  changeIdentity?: string;
  branchId: string;
  occurredAt: string | null;
  additions: number | null;
  deletions: number | null;
  source?: BranchPublicationLocSource;
};

export type CostContribution = {
  sourceEventId: string;
  branchId: string;
  sessionId: string;
  occurredAt: string | null;
  phase: CostPhase | null;
  costUsd: number | null;
  qualifyingBranchCount: number | null;
};

/** A Session/Branch cost link whose value is unavailable or invalid. */
export type IncompleteCostContribution = {
  sourceEventId: string;
  branchId: string;
  occurredAt: string | null;
};

export type PullRequestEvidence = {
  identity: string;
  branchId: string;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
};

export type BranchMetricEvidence = {
  statusSnapshots: readonly StatusSnapshot[];
  locContributions: readonly LocContribution[];
  locCompleteBranchIds: readonly string[];
  costContributions: readonly CostContribution[];
  /** Unavailable Session cost links retained so completeness can follow time windows. */
  costIncompleteContributions: readonly IncompleteCostContribution[];
  /** Branches with complete lifetime Session cost coverage. */
  costCompleteBranchIds: readonly string[];
  pullRequests: readonly PullRequestEvidence[];
  pullRequestCoverageComplete: boolean;
  /** Pre-publication Branch scope used only by the LOC/$ denominator. */
  locPerDollarDenominatorBranchIds?: readonly string[];
  locPerDollarQualifyingSessionIds?: readonly string[];
  locPerDollarCostCoverageComplete?: boolean;
};

export type MetricWindow = { startAt: number | null; endAt: number };
