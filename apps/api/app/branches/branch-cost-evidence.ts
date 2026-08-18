import {
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
  branchCostEvidenceHasSubtotal,
  branchCostSubtotalsReconcile,
} from "@repo/api/src/types/branch-usage";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import type { Prisma } from "@repo/database";

export type CloudCostEvidenceEvent = {
  agentSessionId: string;
  eventCreatedAt: Date | null;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
  estimatedCost: { toString(): string } | number | null;
  sourceIdentity: Prisma.JsonValue | null;
  costCompleteness: string | null;
  costCompletenessReason: string | null;
  subscriptionEquivalentCost: { toString(): string } | number | null;
  apiEstimatedCost: { toString(): string } | number | null;
};

export type CloudLifetimeSession = {
  artifactId: string;
  estimatedCost: { toString(): string } | number;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
};

export type CloudEventTokenTotals = Map<string, bigint | undefined>;

/** Convert one persisted cloud event to provider-neutral Branch evidence. */
export function toBranchCostContribution(
  event: CloudCostEvidenceEvent
): BranchCostEvidenceContribution {
  const fallbackSubtotalUsd = nullableNumberFromDecimal(event.estimatedCost);
  const structured = persistedCostSummary(event);
  return {
    ...(event.sourceIdentity === null
      ? {}
      : { sourceIdentity: event.sourceIdentity }),
    ...(structured.costSummary === undefined
      ? {}
      : { costSummary: structured.costSummary }),
    ...(fallbackSubtotalUsd === undefined ? {} : { fallbackSubtotalUsd }),
    ...(structured.reason === undefined ? {} : { reason: structured.reason }),
  };
}

/** Mark event evidence when it cannot reconcile exactly with lifetime rows. */
export function applyCloudLifetimeCoverage(
  sessions: readonly CloudLifetimeSession[],
  events: readonly CloudCostEvidenceEvent[],
  contributions: BranchCostEvidenceContribution[],
  eventTokensBySession: ReadonlyMap<
    string,
    bigint | undefined
  > = accumulateCloudEventTokenTotals(events)
): void {
  const eventIndexesBySession = new Map<string, number[]>();
  const eventCostsBySession = new Map<string, ObservedCostSubtotal>();
  for (const [index, event] of events.entries()) {
    const indexes = eventIndexesBySession.get(event.agentSessionId) ?? [];
    indexes.push(index);
    eventIndexesBySession.set(event.agentSessionId, indexes);
    const cost = eventCostsBySession.get(event.agentSessionId) ?? {
      observed: false,
      subtotalUsd: 0,
    };
    if (event.estimatedCost !== null) {
      cost.observed = true;
      cost.subtotalUsd += numberFromDecimal(event.estimatedCost);
    }
    eventCostsBySession.set(event.agentSessionId, cost);
  }
  for (const session of sessions) {
    applySessionCoverage(
      session,
      eventIndexesBySession.get(session.artifactId) ?? [],
      eventTokensBySession.get(session.artifactId),
      eventCostsBySession.get(session.artifactId),
      contributions
    );
  }
}

/** Increment exact per-session token totals while event pages are streamed. */
export function accumulateCloudEventTokenTotals(
  events: readonly CloudCostEvidenceEvent[],
  totals: CloudEventTokenTotals = new Map()
): CloudEventTokenTotals {
  for (const event of events) {
    const prior = totals.has(event.agentSessionId)
      ? totals.get(event.agentSessionId)
      : 0n;
    totals.set(
      event.agentSessionId,
      addExactTokenTotals([prior, exactTokenTotal(event)])
    );
  }
  return totals;
}

/** Store one database-aggregated exact token total for a session. */
export function setCloudEventTokenTotal(
  totals: CloudEventTokenTotals,
  agentSessionId: string,
  values: {
    inputTokens: bigint | number;
    outputTokens: bigint | number;
    cacheReadTokens: bigint | number;
    cacheWriteTokens: bigint | number;
  }
): void {
  totals.set(agentSessionId, exactTokenTotal(values));
}

function applySessionCoverage(
  session: CloudLifetimeSession,
  indexes: readonly number[],
  eventTokens: bigint | undefined,
  eventCost: ObservedCostSubtotal | undefined,
  contributions: BranchCostEvidenceContribution[]
): void {
  const lifetimeTokens = exactTokenTotal(session);
  const lifetimeCost = validCost(session.estimatedCost);
  const tokensMatch =
    lifetimeTokens !== undefined &&
    eventTokens !== undefined &&
    eventTokens === lifetimeTokens;
  const hasEventSubtotal = indexes.some((index) => {
    const contribution = contributions[index];
    return contribution && branchCostEvidenceHasSubtotal(contribution);
  });
  const costsMatch =
    eventCost?.observed === true &&
    branchCostSubtotalsReconcile(eventCost.subtotalUsd, lifetimeCost ?? null);
  const lifetimeMalformed =
    lifetimeTokens === undefined || lifetimeCost === undefined;
  if (lifetimeMalformed) {
    markCoverageIncomplete(indexes, contributions);
    contributions.push({
      ...(!hasEventSubtotal && lifetimeCost !== undefined
        ? {
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Unavailable,
              reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
            },
            fallbackSubtotalUsd: lifetimeCost,
          }
        : {}),
      coverageIncomplete: true,
      reason: BranchCostCompletenessReason.Malformed,
    });
    return;
  }
  if (tokensMatch && costsMatch && indexes.length > 0 && hasEventSubtotal) {
    return;
  }
  markCoverageIncomplete(indexes, contributions);
  if (indexes.length > 0 && hasEventSubtotal) {
    return;
  }
  contributions.push({
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
    },
    fallbackSubtotalUsd: lifetimeCost,
    coverageIncomplete: true,
  });
}

type ObservedCostSubtotal = {
  observed: boolean;
  subtotalUsd: number;
};

function markCoverageIncomplete(
  indexes: readonly number[],
  contributions: BranchCostEvidenceContribution[]
): void {
  for (const index of indexes) {
    const contribution = contributions[index];
    if (contribution) {
      contribution.coverageIncomplete = true;
    }
  }
}

function persistedCostSummary(event: CloudCostEvidenceEvent): {
  costSummary?: unknown;
  reason?: BranchCostCompletenessReason;
} {
  if (event.costCompleteness === null) {
    return {};
  }
  if (event.costCompleteness === TokenCostCompleteness.Unavailable) {
    const reason = persistedCostReason(event.costCompletenessReason);
    return reason.tokenReason
      ? {
          costSummary: {
            completeness: TokenCostCompleteness.Unavailable,
            reason: reason.tokenReason,
          },
        }
      : { reason: reason.branchReason };
  }
  if (
    event.costCompleteness !== TokenCostCompleteness.Complete &&
    event.costCompleteness !== TokenCostCompleteness.Partial
  ) {
    return { reason: BranchCostCompletenessReason.Unknown };
  }
  const subtotalUsd = nullableNumberFromDecimal(event.estimatedCost);
  if (subtotalUsd === undefined) {
    return { reason: BranchCostCompletenessReason.Malformed };
  }
  const lanes = persistedCostLanes(event);
  if (event.costCompleteness === TokenCostCompleteness.Complete) {
    return {
      costSummary: {
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd,
        ...(lanes.length === 0 ? {} : { lanes }),
      },
    };
  }
  const reason = persistedCostReason(event.costCompletenessReason);
  if (!reason.tokenReason) {
    return { reason: reason.branchReason };
  }
  return {
    costSummary: {
      completeness: TokenCostCompleteness.Partial,
      reason: reason.tokenReason,
      subtotalUsd,
      ...(lanes.length === 0 ? {} : { lanes }),
    },
  };
}

function persistedCostLanes(event: CloudCostEvidenceEvent) {
  const lanes: {
    basis: (typeof TokenCostBasis)[keyof typeof TokenCostBasis];
    subtotalUsd: number;
  }[] = [];
  const subscription = nullableNumberFromDecimal(
    event.subscriptionEquivalentCost
  );
  const api = nullableNumberFromDecimal(event.apiEstimatedCost);
  if (subscription !== undefined) {
    lanes.push({
      basis: TokenCostBasis.SubscriptionEquivalent,
      subtotalUsd: subscription,
    });
  }
  if (api !== undefined) {
    lanes.push({ basis: TokenCostBasis.ApiEstimated, subtotalUsd: api });
  }
  return lanes;
}

function persistedCostReason(reason: string | null): {
  tokenReason?: TokenCostCompletenessReason;
  branchReason: BranchCostCompletenessReason;
} {
  for (const known of Object.values(TokenCostCompletenessReason)) {
    if (reason === known) {
      return {
        tokenReason: known,
        branchReason: BranchCostCompletenessReason.Unknown,
      };
    }
  }
  return { branchReason: BranchCostCompletenessReason.Unknown };
}

function nullableNumberFromDecimal(
  value: { toString(): string } | number | null
): number | undefined {
  if (value === null) {
    return;
  }
  return typeof value === "number" ? value : Number(value.toString());
}

function numberFromDecimal(value: { toString(): string } | number): number {
  return typeof value === "number" ? value : Number(value.toString());
}

function validCost(value: { toString(): string } | number): number | undefined {
  const parsed = numberFromDecimal(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function exactTokenTotal(values: {
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
}): bigint | undefined {
  return addExactTokenTotals([
    exactTokenValue(values.inputTokens),
    exactTokenValue(values.outputTokens),
    exactTokenValue(values.cacheReadTokens),
    exactTokenValue(values.cacheWriteTokens),
  ]);
}

function exactTokenValue(value: bigint | number): bigint | undefined {
  if (typeof value === "bigint") {
    return value >= 0n ? value : undefined;
  }
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

function addExactTokenTotals(
  values: readonly (bigint | undefined)[]
): bigint | undefined {
  let total = 0n;
  for (const value of values) {
    if (value === undefined) {
      return;
    }
    total += value;
  }
  return total;
}
