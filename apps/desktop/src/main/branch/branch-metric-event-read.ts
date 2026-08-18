import { MICRO_CENTS_PER_USD } from "@repo/lib/branches/activity-attribution";
import { resolveCanonicalBranchMetricWindows } from "@repo/lib/branches/branch-list-metric-projection";
import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";
import type {
  BranchMetricEventEvidenceRead,
  BranchMetricOutsideEventProvenanceRow,
} from "../database/branch-metric-event-provenance.js";
import {
  type BranchKeyRow,
  type BranchUsageTokenRow,
  readBranchUsageEventRows,
} from "../database/branch-reads.js";
import type { DbHostAgentDatabase } from "../database/sqlite-contract.js";
import { readBranchMetricEventEvidenceForScope } from "./branch-empty-scope-reads.js";

/** A pinned, canonically scoped token-event population for metric projection. */
export type CanonicalBranchMetricEventRead = {
  rows: BranchUsageTokenRow[];
  requestBoundary: Date;
  activitySegments: BranchMetricEventEvidenceRead["activitySegments"];
};

/**
 * Read the canonical current/prior metric span while retaining compact evidence
 * from older and future events that can still affect phase-cost completeness.
 */
export async function readCanonicalBranchMetricEventRows(
  source: Pick<DbHostAgentDatabase, "prisma" | "readBranchMetricEventEvidence">,
  request: SharedBranchesQuery,
  requestBoundary: Date,
  branchKeys?: readonly BranchKeyRow[]
): Promise<CanonicalBranchMetricEventRead> {
  const windows = resolveCanonicalBranchMetricWindows({
    startDate: request.startDate,
    endDate: request.endDate,
    now: requestBoundary,
  });
  const bounds = {
    ...(windows.prior?.startAt ? { startIso: windows.prior.startAt } : {}),
    endIso: resolveMetricReadEndIso(
      request.endDate,
      windows.current.endAt,
      requestBoundary
    ),
  };
  const [rows, evidenceRead] = await Promise.all([
    readBranchUsageEventRows(source.prisma, bounds),
    readBranchMetricEventEvidenceForScope(source, { bounds, branchKeys }),
  ]);
  return {
    rows: [
      ...rows,
      ...evidenceRead.outsideProvenance.flatMap(syntheticEvidenceRows),
    ],
    requestBoundary,
    activitySegments: evidenceRead.activitySegments,
  };
}

/** Keep start-only request semantics open through the pinned read boundary. */
function resolveMetricReadEndIso(
  requestedEnd: string | undefined,
  canonicalEnd: string,
  requestBoundary: Date
): string {
  if (requestedEnd && !Number.isNaN(Date.parse(requestedEnd))) {
    return canonicalEnd;
  }
  return requestBoundary.toISOString();
}

function syntheticEvidenceRows(
  provenance: BranchMetricOutsideEventProvenanceRow
): BranchUsageTokenRow[] {
  const common = {
    sessionId: provenance.sessionId,
    model: "branch-metric-outside-provenance",
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    billingMode: null,
    createdAt: provenance.representativeOccurredAt,
    sessionStartedAt: new Date(provenance.startMs).toISOString(),
  };
  const identity = `${provenance.segmentId}:${provenance.side}`;
  const rows: BranchUsageTokenRow[] = [];
  if (provenance.sourceEventCount > 0) {
    rows.push({
      ...common,
      eventRowId: `branch-metric-provenance:${identity}:source`,
      inputTokens: provenance.inputTokens,
      outputTokens: provenance.outputTokens,
      cacheReadTokens: provenance.cacheReadTokens,
      cacheWriteTokens: provenance.cacheWriteTokens,
      costUsdEstimated: syntheticCostUsd(provenance),
      ...(provenance.positiveCostEventCount > 0
        ? { positiveCostSignal: true as const }
        : {}),
      ...(provenance.tokenCountsInvalid ? { tokenCountsInvalid: true } : {}),
    });
  }
  if (provenance.invalidCostValuePresent) {
    rows.push({
      ...common,
      eventRowId: `branch-metric-provenance:${identity}:invalid-cost`,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEstimated: Number.NaN,
    });
  }
  return rows;
}

function syntheticCostUsd(
  provenance: BranchMetricOutsideEventProvenanceRow
): number | null {
  if (provenance.validCostEventCount === 0) {
    return null;
  }
  return provenance.costMicroCents / MICRO_CENTS_PER_USD;
}
