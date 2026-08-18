import { z } from "zod";

import type { BranchPhase, BranchViewerScope } from "./branch.ts";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  type TokenCostLane,
  type TokenCostSummary,
  type TokenSourceIdentity,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
  tokenCostSummarySchema,
  tokenSourceIdentitySchema,
} from "./token-cost-provenance.ts";

/** Branch-level reasons, ordered separately by {@link branchReasonPrecedence}. */
export const BranchCostCompletenessReason = {
  ConflictingSourceIdentity: "conflicting_source_identity",
  Malformed: "malformed",
  CoverageIncomplete: "coverage_incomplete",
  UnsupportedSource: "unsupported_source",
  LegacyRecord: "legacy_record",
  SourceIdentityUnavailable: "source_identity_unavailable",
  ClassificationIncomplete: "classification_incomplete",
  PricingIncomplete: "pricing_incomplete",
  Unknown: "unknown",
} as const;
export type BranchCostCompletenessReason =
  (typeof BranchCostCompletenessReason)[keyof typeof BranchCostCompletenessReason];

/** Completeness states exposed by Branch usage projections. */
export const BranchCostCompleteness = TokenCostCompleteness;
export type BranchCostCompleteness = TokenCostCompleteness;

export const branchCostCompletenessReasonSchema = z.enum(
  BranchCostCompletenessReason
);

const branchCostLaneTotalsSchema = z
  .object({
    subscriptionEquivalentCost: z.number().finite().nonnegative(),
    apiEstimatedCost: z.number().finite().nonnegative(),
  })
  .strict();

const completeBranchCostCompletenessSchema = z
  .object({
    completeness: z.literal(BranchCostCompleteness.Complete),
    subtotalUsd: z.number().finite().nonnegative(),
    lanes: branchCostLaneTotalsSchema.optional(),
  })
  .strict();

const partialBranchCostCompletenessSchema = z
  .object({
    completeness: z.literal(BranchCostCompleteness.Partial),
    reason: branchCostCompletenessReasonSchema,
    subtotalUsd: z.number().finite().nonnegative(),
    lanes: branchCostLaneTotalsSchema.optional(),
  })
  .strict();

const unavailableBranchCostCompletenessSchema = z
  .object({
    completeness: z.literal(BranchCostCompleteness.Unavailable),
    reason: branchCostCompletenessReasonSchema,
  })
  .strict();

/** Runtime schema for the additive Branch cost-completeness result. */
export const branchCostCompletenessSchema = z.discriminatedUnion(
  "completeness",
  [
    completeBranchCostCompletenessSchema,
    partialBranchCostCompletenessSchema,
    unavailableBranchCostCompletenessSchema,
  ]
);
export type BranchCostCompletenessResult = z.infer<
  typeof branchCostCompletenessSchema
>;

/** One provider-neutral persisted contribution consumed by a Branch fold. */
export type BranchCostEvidenceContribution = {
  sourceIdentity?: unknown;
  costSummary?: unknown;
  /** Separately captured numeric cost retained when structured evidence is absent. */
  fallbackSubtotalUsd?: unknown;
  /** True when the owning projection proves the event population is incomplete. */
  coverageIncomplete?: boolean;
  /** Adapter-observed defect that cannot be represented by producer schemas. */
  reason?: BranchCostCompletenessReason;
};

/** Cross-surface cap for Branch cost-evidence rows retained by one request. */
export const branchCostEvidenceRowBudget = 10_000;
/** Cross-surface cap for retained Branch cost-evidence payload bytes. */
export const branchCostEvidenceByteBudget = 16 * 1024 * 1024;
/** Conservative allowance for fixed fields alongside each provenance payload. */
export const branchCostEvidenceFixedRowBytes = 1024;

/**
 * Cross-surface evidence accounting: UTF-8 bytes for every serialized variable
 * evidence payload plus one fixed allowance for scalar fields and row overhead.
 */
export function branchCostEvidenceRetainedBytes(
  variablePayloadBytes: number
): number {
  return variablePayloadBytes + branchCostEvidenceFixedRowBytes;
}

export type BranchUsageActorBucket = {
  /** NULL = "unattributed". */
  owner: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

export type BranchUsageHourBucket = {
  /** ISO truncated to the hour (UTC default; tz-option upstream). */
  hourStart: string;
  byActor: BranchUsageActorBucket[];
};

export type BranchUsagePhaseStack = {
  phase: BranchPhase;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
};

export type BranchUsageSummary = {
  viewerScope: BranchViewerScope;
  totalBranches: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalEstimatedCost: number;
  /** BranchBillingMode.Subscription split (v1-degraded best-effort). */
  subscriptionEstimatedCost: number;
  /** BranchBillingMode.Api split (v1-degraded best-effort). */
  apiEstimatedCost: number;
  /** Additive typed provenance; omitted by version-skewed producers. */
  costCompleteness?: BranchCostCompletenessResult;
  /** per-hour-per-actor (FEA-1834 O(grouped)). */
  hourBuckets: BranchUsageHourBucket[];
  /** phase-stacked cost/tokens (v1-degraded best-effort). */
  phaseStacks: BranchUsagePhaseStack[];
  /** rolled-up per-actor totals. */
  byActor: BranchUsageActorBucket[];
};

/**
 * Fold persisted event evidence once across a complete filtered Branch corpus.
 * Only a validated source identity can prove replay; uncertain rows remain
 * independent, and a conflicting proven identity is excluded conservatively.
 */
export function aggregateBranchCostCompleteness(
  contributions: readonly BranchCostEvidenceContribution[]
): BranchCostCompletenessResult {
  if (contributions.length === 0) {
    return {
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    };
  }
  const normalized = contributions.map(normalizeContribution);
  const reasons = new Set<BranchCostCompletenessReason>();
  for (const contribution of normalized) {
    for (const reason of contribution.reasons) {
      reasons.add(reason);
    }
  }
  const selected = selectDistinctContributions(normalized, reasons);
  const totals = sumSelectedContributions(selected);
  if (totals.malformed) {
    reasons.add(BranchCostCompletenessReason.Malformed);
  }
  if (!totals.observedSubtotal) {
    return {
      completeness: BranchCostCompleteness.Unavailable,
      reason: highestReason(reasons),
    };
  }
  if (!totals.allObservedSubtotalsHaveLanes) {
    reasons.add(BranchCostCompletenessReason.ClassificationIncomplete);
  }
  const lanes = totals.allObservedSubtotalsHaveLanes
    ? {
        subscriptionEquivalentCost: totals.subscriptionEquivalentCost,
        apiEstimatedCost: totals.apiEstimatedCost,
      }
    : undefined;
  const reason = reasons.size === 0 ? undefined : highestReason(reasons);
  if (reason) {
    return {
      completeness: BranchCostCompleteness.Partial,
      reason,
      subtotalUsd: totals.subtotalUsd,
      ...(lanes ? { lanes } : {}),
    };
  }
  return {
    completeness: BranchCostCompleteness.Complete,
    subtotalUsd: totals.subtotalUsd,
    ...(lanes ? { lanes } : {}),
  };
}

/** Whether persisted evidence contains a validated numeric subtotal, including zero. */
export function branchCostEvidenceHasSubtotal(
  contribution: BranchCostEvidenceContribution
): boolean {
  const parsedSummary = tokenCostSummarySchema.safeParse(
    contribution.costSummary
  );
  if (parsedSummary.success && "subtotalUsd" in parsedSummary.data) {
    return true;
  }
  return (
    typeof contribution.fallbackSubtotalUsd === "number" &&
    Number.isFinite(contribution.fallbackSubtotalUsd) &&
    contribution.fallbackSubtotalUsd >= 0
  );
}

type BranchCostLaneTotals = z.infer<typeof branchCostLaneTotalsSchema>;

type NormalizedContribution = {
  identityKey?: string;
  sourceIdentity?: TokenSourceIdentity;
  costSummary?: TokenCostSummary;
  subtotalUsd?: number;
  lanes?: BranchCostLaneTotals;
  reasons: ReadonlySet<BranchCostCompletenessReason>;
};

type SelectedContributionTotals = BranchCostLaneTotals & {
  subtotalUsd: number;
  observedSubtotal: boolean;
  allObservedSubtotalsHaveLanes: boolean;
  malformed: boolean;
};

const branchReasonPrecedence = [
  BranchCostCompletenessReason.ConflictingSourceIdentity,
  BranchCostCompletenessReason.Malformed,
  BranchCostCompletenessReason.CoverageIncomplete,
  BranchCostCompletenessReason.UnsupportedSource,
  BranchCostCompletenessReason.LegacyRecord,
  BranchCostCompletenessReason.SourceIdentityUnavailable,
  BranchCostCompletenessReason.ClassificationIncomplete,
  BranchCostCompletenessReason.PricingIncomplete,
  BranchCostCompletenessReason.Unknown,
] as const;

function selectDistinctContributions(
  normalized: readonly NormalizedContribution[],
  reasons: Set<BranchCostCompletenessReason>
): NormalizedContribution[] {
  const selected: NormalizedContribution[] = [];
  const provenGroups = new Map<string, NormalizedContribution[]>();
  for (const contribution of normalized) {
    if (contribution.identityKey === undefined) {
      selected.push(contribution);
      continue;
    }
    const group = provenGroups.get(contribution.identityKey) ?? [];
    group.push(contribution);
    provenGroups.set(contribution.identityKey, group);
  }
  for (const group of provenGroups.values()) {
    if (new Set(group.map(evidenceSignature)).size > 1) {
      reasons.add(BranchCostCompletenessReason.ConflictingSourceIdentity);
      continue;
    }
    if (group[0]) {
      selected.push(group[0]);
    }
  }
  return selected;
}

function sumSelectedContributions(
  selected: readonly NormalizedContribution[]
): SelectedContributionTotals {
  const totals: SelectedContributionTotals = {
    subtotalUsd: 0,
    observedSubtotal: false,
    subscriptionEquivalentCost: 0,
    apiEstimatedCost: 0,
    allObservedSubtotalsHaveLanes: true,
    malformed: false,
  };
  for (const contribution of selected) {
    if (contribution.subtotalUsd === undefined) {
      continue;
    }
    totals.observedSubtotal = true;
    totals.subtotalUsd += contribution.subtotalUsd;
    if (!Number.isFinite(totals.subtotalUsd)) {
      totals.observedSubtotal = false;
      totals.malformed = true;
      return totals;
    }
    if (contribution.lanes === undefined) {
      totals.allObservedSubtotalsHaveLanes = false;
      continue;
    }
    totals.subscriptionEquivalentCost +=
      contribution.lanes.subscriptionEquivalentCost;
    totals.apiEstimatedCost += contribution.lanes.apiEstimatedCost;
    if (
      !(
        Number.isFinite(totals.subscriptionEquivalentCost) &&
        Number.isFinite(totals.apiEstimatedCost)
      )
    ) {
      totals.observedSubtotal = false;
      totals.malformed = true;
      return totals;
    }
  }
  return totals;
}

function normalizeContribution(
  contribution: BranchCostEvidenceContribution
): NormalizedContribution {
  const reasons = new Set<BranchCostCompletenessReason>();
  if (contribution.coverageIncomplete) {
    reasons.add(BranchCostCompletenessReason.CoverageIncomplete);
  }
  if (contribution.reason) {
    reasons.add(contribution.reason);
  }
  const sourceIdentity = parseSourceIdentity(
    contribution.sourceIdentity,
    reasons
  );
  const costSummary = parseCostSummary(contribution.costSummary, reasons);
  const fallbackSubtotalUsd = parseSubtotal(
    contribution.fallbackSubtotalUsd,
    reasons
  );
  const summarySubtotal =
    costSummary && "subtotalUsd" in costSummary
      ? costSummary.subtotalUsd
      : undefined;
  const subtotalUsd = summarySubtotal ?? fallbackSubtotalUsd;
  if (
    costSummary === undefined &&
    contribution.reason === undefined &&
    !reasons.has(BranchCostCompletenessReason.Unknown)
  ) {
    reasons.add(BranchCostCompletenessReason.PricingIncomplete);
  }
  const lanes = costSummary ? normalizeLanes(costSummary) : undefined;
  return {
    ...(sourceIdentity ? { sourceIdentity } : {}),
    ...(sourceIdentity?.availability ===
    TokenSourceIdentityAvailability.Available
      ? {
          identityKey: JSON.stringify([
            sourceIdentity.scheme,
            ...sourceIdentity.sourceRecordIds,
          ]),
        }
      : {}),
    ...(costSummary ? { costSummary } : {}),
    ...(subtotalUsd === undefined ? {} : { subtotalUsd }),
    ...(lanes ? { lanes } : {}),
    reasons,
  };
}

function parseSourceIdentity(
  value: unknown,
  reasons: Set<BranchCostCompletenessReason>
): TokenSourceIdentity | undefined {
  if (value === undefined || value === null) {
    reasons.add(BranchCostCompletenessReason.SourceIdentityUnavailable);
    return;
  }
  const parsed = tokenSourceIdentitySchema.safeParse(value);
  if (!parsed.success) {
    reasons.add(
      hasUnknownDiscriminant(value, "availability", [
        TokenSourceIdentityAvailability.Available,
        TokenSourceIdentityAvailability.Unavailable,
      ]) || isForwardCompatibleSourceIdentity(value)
        ? BranchCostCompletenessReason.Unknown
        : BranchCostCompletenessReason.Malformed
    );
    return;
  }
  if (
    parsed.data.availability === TokenSourceIdentityAvailability.Unavailable
  ) {
    reasons.add(mapIdentityReason(parsed.data.reason));
  }
  return parsed.data;
}

function parseCostSummary(
  value: unknown,
  reasons: Set<BranchCostCompletenessReason>
): TokenCostSummary | undefined {
  if (value === undefined || value === null) {
    return;
  }
  const parsed = tokenCostSummarySchema.safeParse(value);
  if (!parsed.success) {
    reasons.add(
      hasUnknownDiscriminant(value, "completeness", [
        TokenCostCompleteness.Complete,
        TokenCostCompleteness.Partial,
        TokenCostCompleteness.Unavailable,
      ]) || isForwardCompatibleCostSummary(value)
        ? BranchCostCompletenessReason.Unknown
        : BranchCostCompletenessReason.Malformed
    );
    return;
  }
  if (parsed.data.completeness !== TokenCostCompleteness.Complete) {
    reasons.add(mapCostReason(parsed.data.reason));
  }
  return parsed.data;
}

function parseSubtotal(
  value: unknown,
  reasons: Set<BranchCostCompletenessReason>
): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    reasons.add(BranchCostCompletenessReason.Malformed);
    return;
  }
  return value;
}

function normalizeLanes(
  summary: TokenCostSummary
): BranchCostLaneTotals | undefined {
  if (!("subtotalUsd" in summary) || summary.lanes === undefined) {
    return;
  }
  const totals = { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 };
  for (const lane of summary.lanes) {
    addLane(totals, lane);
  }
  return totals;
}

function addLane(totals: BranchCostLaneTotals, lane: TokenCostLane): void {
  if (lane.basis === TokenCostBasis.SubscriptionEquivalent) {
    totals.subscriptionEquivalentCost += lane.subtotalUsd;
    return;
  }
  if (lane.basis === TokenCostBasis.ApiEstimated) {
    totals.apiEstimatedCost += lane.subtotalUsd;
    return;
  }
  assertNeverCostBasis(lane.basis);
}

function mapIdentityReason(
  reason: TokenSourceIdentityUnavailableReason
): BranchCostCompletenessReason {
  if (reason === TokenSourceIdentityUnavailableReason.LegacyRecord) {
    return BranchCostCompletenessReason.LegacyRecord;
  }
  if (reason === TokenSourceIdentityUnavailableReason.UnsupportedSource) {
    return BranchCostCompletenessReason.UnsupportedSource;
  }
  if (reason === TokenSourceIdentityUnavailableReason.Malformed) {
    return BranchCostCompletenessReason.Malformed;
  }
  if (reason === TokenSourceIdentityUnavailableReason.Unknown) {
    return BranchCostCompletenessReason.Unknown;
  }
  return BranchCostCompletenessReason.SourceIdentityUnavailable;
}

function mapCostReason(
  reason: TokenCostCompletenessReason
): BranchCostCompletenessReason {
  if (reason === TokenCostCompletenessReason.LegacyRecord) {
    return BranchCostCompletenessReason.LegacyRecord;
  }
  if (reason === TokenCostCompletenessReason.UnsupportedSource) {
    return BranchCostCompletenessReason.UnsupportedSource;
  }
  if (reason === TokenCostCompletenessReason.SourceIdentityUnavailable) {
    return BranchCostCompletenessReason.SourceIdentityUnavailable;
  }
  if (reason === TokenCostCompletenessReason.ClassificationIncomplete) {
    return BranchCostCompletenessReason.ClassificationIncomplete;
  }
  if (reason === TokenCostCompletenessReason.PricingIncomplete) {
    return BranchCostCompletenessReason.PricingIncomplete;
  }
  if (reason === TokenCostCompletenessReason.Malformed) {
    return BranchCostCompletenessReason.Malformed;
  }
  return BranchCostCompletenessReason.Unknown;
}

function evidenceSignature(contribution: NormalizedContribution): string {
  return JSON.stringify({
    completeness: contribution.costSummary?.completeness,
    reason:
      contribution.costSummary && "reason" in contribution.costSummary
        ? contribution.costSummary.reason
        : undefined,
    subtotalUsd: contribution.subtotalUsd,
    lanes: contribution.lanes,
  });
}

function isForwardCompatibleSourceIdentity(value: unknown): boolean {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const record = parsed.data;
  const availability = record.availability;
  if (availability === TokenSourceIdentityAvailability.Available) {
    return tokenSourceIdentitySchema.safeParse({
      availability,
      scheme: record.scheme,
      sourceRecordIds: record.sourceRecordIds,
    }).success;
  }
  if (availability !== TokenSourceIdentityAvailability.Unavailable) {
    return false;
  }
  const reason = knownOrForwardReason(
    record.reason,
    Object.values(TokenSourceIdentityUnavailableReason),
    TokenSourceIdentityUnavailableReason.Unknown
  );
  return tokenSourceIdentitySchema.safeParse({ availability, reason }).success;
}

function isForwardCompatibleCostSummary(value: unknown): boolean {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const record = parsed.data;
  const completeness = record.completeness;
  if (completeness === TokenCostCompleteness.Unavailable) {
    return tokenCostSummarySchema.safeParse({
      completeness,
      reason: knownOrForwardReason(
        record.reason,
        Object.values(TokenCostCompletenessReason),
        TokenCostCompletenessReason.Unknown
      ),
    }).success;
  }
  if (
    completeness !== TokenCostCompleteness.Complete &&
    completeness !== TokenCostCompleteness.Partial
  ) {
    return false;
  }
  const subtotal = forwardCostSubtotalSchema.safeParse(record.subtotalUsd);
  if (!subtotal.success) {
    return false;
  }
  if (
    completeness === TokenCostCompleteness.Partial &&
    typeof record.reason !== "string"
  ) {
    return false;
  }
  return forwardCostLanesReconcile(record.lanes, subtotal.data);
}

function forwardCostLanesReconcile(
  value: unknown,
  subtotalUsd: number
): boolean {
  if (value === undefined) {
    return true;
  }
  const parsed = forwardCostLanesSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const distinctBases = new Set(parsed.data.map((lane) => lane.basis));
  if (distinctBases.size !== parsed.data.length) {
    return false;
  }
  const laneSubtotal = parsed.data.reduce(
    (total, lane) => total + lane.subtotalUsd,
    0
  );
  const tolerance =
    forwardCostSumEpsilon *
    Math.max(1, Math.abs(laneSubtotal), Math.abs(subtotalUsd));
  return Math.abs(laneSubtotal - subtotalUsd) <= tolerance;
}

function knownOrForwardReason<Reason extends string>(
  value: unknown,
  known: readonly Reason[],
  fallback: Reason
): unknown {
  return typeof value === "string" && !known.includes(value as Reason)
    ? fallback
    : value;
}

function hasUnknownDiscriminant(
  value: unknown,
  key: string,
  knownValues: readonly string[]
): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const discriminant = (value as Record<string, unknown>)[key];
  return (
    typeof discriminant === "string" && !knownValues.includes(discriminant)
  );
}

function highestReason(
  reasons: ReadonlySet<BranchCostCompletenessReason>
): BranchCostCompletenessReason {
  return (
    branchReasonPrecedence.find((reason) => reasons.has(reason)) ??
    BranchCostCompletenessReason.Unknown
  );
}

function assertNeverCostBasis(value: never): never {
  throw new Error(`Unhandled token cost basis: ${String(value)}`);
}

/** Reconcile two optional Branch cost subtotals with the shared float tolerance. */
export function branchCostSubtotalsReconcile(
  left: number | null,
  right: number | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  const tolerance =
    forwardCostSumEpsilon * Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= tolerance;
}

const forwardCostSubtotalSchema = z.number().finite().nonnegative();
const forwardCostLanesSchema = z
  .array(
    z
      .object({
        basis: z.string().min(1),
        subtotalUsd: forwardCostSubtotalSchema,
      })
      .passthrough()
  )
  .min(1);
const forwardCostSumEpsilon = 1e-12;
