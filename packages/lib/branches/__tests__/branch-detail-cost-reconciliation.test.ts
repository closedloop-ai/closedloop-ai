import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import { resolveDetailPhaseTotal } from "../branch-detail-cost-reconciliation";

const PRICED_SEGMENT: BranchPhaseAttributionResult["segments"][number] = {
  sessionId: "session-1",
  sequence: 0,
  phase: BranchVisibleLifecyclePhase.Build,
  startMs: 0,
  endMs: 60_000,
  estimatedCostUsd: 8,
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  evidenceIds: [],
  qualifyingBranchCount: 1,
  costEvents: [{ sourceEventId: "event-1", occurredAtMs: 1000, costUsd: 8 }],
};

function partialAttribution(
  reason: BranchPhaseAttributionCompletenessReason
): BranchPhaseAttributionResult {
  return {
    segments: [PRICED_SEGMENT],
    rollups: [],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason,
      subtotalUsd: 8,
    },
  };
}

describe("resolveDetailPhaseTotal row evidence", () => {
  it("keeps priced rows whole when only the PR lifecycle is unknown", () => {
    const resolved = resolveDetailPhaseTotal(
      partialAttribution(
        BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
      ),
      24,
      8
    );
    expect(resolved?.rowEvidenceComplete).toBe(true);
    expect(resolved?.rowsComplete).toBe(false);
  });

  it("still reports short row evidence when pricing is incomplete", () => {
    const resolved = resolveDetailPhaseTotal(
      partialAttribution(
        BranchPhaseAttributionCompletenessReason.PricingIncomplete
      ),
      24,
      8
    );
    expect(resolved?.rowEvidenceComplete).toBe(false);
  });
});
