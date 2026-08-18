import {
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
  branchCostEvidenceHasSubtotal,
  branchCostSubtotalsReconcile,
} from "@repo/api/src/types/branch-usage";
import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import type { BranchUsageTokenRow } from "../database/branch-reads.js";

/** Build provider-neutral completeness evidence without changing numeric usage. */
export function buildDesktopBranchCostEvidence(
  input: DesktopBranchCostEvidenceInput
): BranchCostEvidenceContribution[] {
  if (input.evidenceExceeded) {
    return [
      coverageIncompleteContribution(input.subtotalRows, input.allEventRows),
    ];
  }
  const contributions = input.evidenceRows.map(toEvidenceContribution);
  if (input.windowActive) {
    for (const row of input.allEventRows) {
      if (hasInvalidTimestamp(row.createdAt)) {
        contributions.push({
          coverageIncomplete: true,
          ...(row.tokenCountsInvalid
            ? { reason: BranchCostCompletenessReason.Malformed }
            : {}),
        });
      }
    }
    return contributions;
  }
  applyDesktopLifetimeCoverage(
    input.tokenRows,
    input.evidenceRows,
    contributions
  );
  return contributions;
}

function coverageIncompleteContribution(
  subtotalRows: readonly BranchUsageTokenRow[],
  evidenceRows: readonly BranchUsageTokenRow[]
): BranchCostEvidenceContribution {
  const malformed =
    subtotalRows.some((row) => row.tokenCountsInvalid) ||
    evidenceRows.some(
      (row) => row.tokenCountsInvalid || hasMalformedCost(row)
    ) ||
    sumTokens(subtotalRows) === undefined ||
    sumTokens(evidenceRows) === undefined;
  let observedSubtotal = false;
  let subtotalUsd = 0;
  let malformedCost = false;
  for (const row of subtotalRows) {
    if (row.costUsdEstimated !== null) {
      observedSubtotal = true;
      malformedCost ||=
        !Number.isFinite(row.costUsdEstimated) || row.costUsdEstimated < 0;
      subtotalUsd += row.costUsdEstimated;
    }
  }
  if (!observedSubtotal) {
    return {
      coverageIncomplete: true,
      ...(malformed ? { reason: BranchCostCompletenessReason.Malformed } : {}),
    };
  }
  if (malformedCost || !(Number.isFinite(subtotalUsd) && subtotalUsd >= 0)) {
    return {
      coverageIncomplete: true,
      reason: BranchCostCompletenessReason.Malformed,
    };
  }
  return {
    coverageIncomplete: true,
    fallbackSubtotalUsd: subtotalUsd,
    ...(malformed ? { reason: BranchCostCompletenessReason.Malformed } : {}),
  };
}

function hasMalformedCost(row: BranchUsageTokenRow): boolean {
  return (
    row.costUsdEstimated !== null &&
    (!Number.isFinite(row.costUsdEstimated) || row.costUsdEstimated < 0)
  );
}

function sumTokens(rows: readonly BranchUsageTokenRow[]): bigint | undefined {
  let total = 0n;
  for (const row of rows) {
    for (const value of tokenValues(row)) {
      if (!(Number.isSafeInteger(value) && value >= 0)) {
        return;
      }
      total += BigInt(value);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
        return;
      }
    }
  }
  return total;
}

function sumObservedCost(
  rows: readonly BranchUsageTokenRow[]
): ObservedCostSubtotal {
  let observed = false;
  let subtotalUsd = 0;
  let malformed = false;
  for (const row of rows) {
    if (row.costUsdEstimated !== null) {
      if (hasMalformedCost(row)) {
        malformed = true;
        continue;
      }
      observed = true;
      subtotalUsd += row.costUsdEstimated;
      if (!Number.isFinite(subtotalUsd)) {
        return { observed: false, subtotalUsd: 0, malformed: true };
      }
    }
  }
  return { observed, subtotalUsd, malformed };
}

function toEvidenceContribution(
  row: BranchUsageTokenRow
): BranchCostEvidenceContribution {
  return {
    ...(row.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: row.sourceIdentity }),
    ...(row.costSummary === undefined ? {} : { costSummary: row.costSummary }),
    ...(row.costUsdEstimated === null
      ? {}
      : { fallbackSubtotalUsd: row.costUsdEstimated }),
    ...(row.tokenCountsInvalid
      ? { reason: BranchCostCompletenessReason.Malformed }
      : {}),
  };
}

function applyDesktopLifetimeCoverage(
  tokenRows: readonly BranchUsageTokenRow[],
  eventRows: readonly BranchUsageTokenRow[],
  contributions: BranchCostEvidenceContribution[]
): void {
  const eventIndexesBySession = new Map<string, number[]>();
  const eventRowsBySession = groupUsageRowsBySession(eventRows);
  for (const [index, row] of eventRows.entries()) {
    const indexes = eventIndexesBySession.get(row.sessionId) ?? [];
    indexes.push(index);
    eventIndexesBySession.set(row.sessionId, indexes);
  }
  const tokenRowsBySession = groupUsageRowsBySession(tokenRows);
  const sessionIds = new Set([
    ...tokenRowsBySession.keys(),
    ...eventIndexesBySession.keys(),
  ]);
  for (const sessionId of sessionIds) {
    const sessionTokenRows = tokenRowsBySession.get(sessionId) ?? [];
    applyDesktopSessionCoverage(
      sessionId,
      sessionTokenRows,
      eventIndexesBySession,
      eventRowsBySession,
      contributions
    );
  }
}

function groupUsageRowsBySession(
  tokenRows: readonly BranchUsageTokenRow[]
): Map<string, BranchUsageTokenRow[]> {
  const tokenRowsBySession = new Map<string, BranchUsageTokenRow[]>();
  for (const row of tokenRows) {
    const rows = tokenRowsBySession.get(row.sessionId) ?? [];
    rows.push(row);
    tokenRowsBySession.set(row.sessionId, rows);
  }
  return tokenRowsBySession;
}

function applyDesktopSessionCoverage(
  sessionId: string,
  tokenRows: readonly BranchUsageTokenRow[],
  eventIndexesBySession: ReadonlyMap<string, number[]>,
  eventRowsBySession: ReadonlyMap<string, BranchUsageTokenRow[]>,
  contributions: BranchCostEvidenceContribution[]
): void {
  const indexes = eventIndexesBySession.get(sessionId) ?? [];
  if (tokenRows.length === 0) {
    markCoverageIncomplete(indexes, contributions);
    return;
  }
  const lifetimeTokens = sumTokens(tokenRows);
  const eventRows = eventRowsBySession.get(sessionId) ?? [];
  const eventTokens = sumTokens(eventRows);
  const eventTokensMatch =
    lifetimeTokens !== undefined &&
    eventTokens !== undefined &&
    eventTokens === lifetimeTokens;
  const lifetimeCost = sumObservedCost(tokenRows);
  const eventCost = sumObservedCost(eventRows);
  const eventCostsMatch =
    lifetimeCost.observed &&
    eventCost.observed &&
    branchCostSubtotalsReconcile(
      lifetimeCost.subtotalUsd,
      eventCost.subtotalUsd
    );
  const hasEventSubtotal = indexes.some((index) => {
    const contribution = contributions[index];
    return contribution && branchCostEvidenceHasSubtotal(contribution);
  });
  if (
    lifetimeTokens === undefined ||
    eventTokens === undefined ||
    lifetimeCost.malformed ||
    eventCost.malformed ||
    tokenRows.some((row) => row.tokenCountsInvalid) ||
    eventRows.some((row) => row.tokenCountsInvalid)
  ) {
    contributions.push({ reason: BranchCostCompletenessReason.Malformed });
  }
  if (
    eventTokensMatch &&
    eventCostsMatch &&
    indexes.length > 0 &&
    hasEventSubtotal
  ) {
    return;
  }
  markCoverageIncomplete(indexes, contributions);
  if (indexes.length > 0 && hasEventSubtotal) {
    return;
  }
  for (const row of tokenRows) {
    contributions.push({
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
      },
      ...(row.costUsdEstimated === null || hasMalformedCost(row)
        ? {}
        : { fallbackSubtotalUsd: row.costUsdEstimated }),
      coverageIncomplete: true,
    });
  }
}

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

function hasInvalidTimestamp(value: string | null): boolean {
  return value === null || Number.isNaN(Date.parse(value));
}

function tokenValues(row: BranchUsageTokenRow): readonly number[] {
  return [
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
  ];
}

export type DesktopBranchCostEvidenceInput = {
  tokenRows: readonly BranchUsageTokenRow[];
  evidenceRows: readonly BranchUsageTokenRow[];
  allEventRows: readonly BranchUsageTokenRow[];
  subtotalRows: readonly BranchUsageTokenRow[];
  windowActive: boolean;
  evidenceExceeded: boolean;
};

type ObservedCostSubtotal = {
  observed: boolean;
  subtotalUsd: number;
  malformed: boolean;
};
