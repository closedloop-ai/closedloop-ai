import type { BranchAssociatedPullRequest } from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPullRequestOutcome,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import { expectPartialMetric } from "./__tests__/coverage-narrowing";
import {
  branchMetricCycleFromPullRequest,
  calculateBranchDetailMetrics,
} from "./branch-detail-outcomes";

// ---------------------------------------------------------------------------
// Inline helpers — NO default parameters, NO ternaries, ZERO denominator branches.
// ---------------------------------------------------------------------------

const OPENED = "2026-08-01T10:00:00.000Z";
const PUSH = "2026-08-01T11:00:00.000Z";
const TERMINAL = "2026-08-01T13:00:00.000Z";

function pr(
  state: GitHubPRState,
  isDraft: boolean,
  mergedAt: string | null,
  closedAt: string | null
): BranchAssociatedPullRequest {
  return {
    id: "acme/web#1",
    repositoryFullName: "acme/web",
    number: 1,
    title: null,
    url: null,
    state,
    isDraft,
    reviewDecision: null,
    openedAt: OPENED,
    closedAt,
    mergedAt,
  };
}

function emptyAttribution(): BranchPhaseAttributionResult {
  return {
    segments: [],
    rollups: [
      {
        phase: BranchVisibleLifecyclePhase.Build,
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        sessionCount: 0,
      },
      {
        phase: BranchVisibleLifecyclePhase.Review,
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        sessionCount: 0,
      },
      {
        phase: BranchVisibleLifecyclePhase.Rework,
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        sessionCount: 0,
      },
    ],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0,
    },
  };
}

function mergedCycle() {
  return {
    cycleId: "acme/web#1",
    openedAt: OPENED,
    terminalAt: TERMINAL,
    outcome: BranchMetricPullRequestOutcome.Merged,
    successfulPushes: [{ cycleId: "acme/web#1", occurredAt: PUSH }],
  };
}

// ---------------------------------------------------------------------------
// branchMetricCycleFromPullRequest
// ---------------------------------------------------------------------------

describe("branchMetricCycleFromPullRequest", () => {
  it("returns null when pullRequest is null", () => {
    const result = branchMetricCycleFromPullRequest(null, null);
    expect(result).toBeNull();
  });

  it("produces Merged outcome when mergedAt is set", () => {
    const result = branchMetricCycleFromPullRequest(
      pr(GitHubPRState.Merged, false, TERMINAL, TERMINAL),
      PUSH
    );
    expect(result?.outcome).toBe(BranchMetricPullRequestOutcome.Merged);
    expect(result?.terminalAt).toBe(TERMINAL);
    expect(result?.successfulPushes).toHaveLength(1);
    expect(result?.successfulPushes[0].occurredAt).toBe(PUSH);
  });

  it("produces ClosedUnmerged outcome for a closed (non-merged) PR", () => {
    const result = branchMetricCycleFromPullRequest(
      pr(GitHubPRState.Closed, false, null, TERMINAL),
      null
    );
    expect(result?.outcome).toBe(BranchMetricPullRequestOutcome.ClosedUnmerged);
    expect(result?.terminalAt).toBe(TERMINAL); // closedAt
    expect(result?.successfulPushes).toHaveLength(0);
  });

  it("produces Draft outcome for an open PR marked as draft", () => {
    const result = branchMetricCycleFromPullRequest(
      pr(GitHubPRState.Open, true, null, null),
      null
    );
    expect(result?.outcome).toBe(BranchMetricPullRequestOutcome.Draft);
    expect(result?.terminalAt).toBeNull();
    expect(result?.successfulPushes).toHaveLength(0);
  });

  it("produces Open outcome for a non-draft open PR", () => {
    const result = branchMetricCycleFromPullRequest(
      pr(GitHubPRState.Open, false, null, null),
      null
    );
    expect(result?.outcome).toBe(BranchMetricPullRequestOutcome.Open);
    expect(result?.openedAt).toBe(OPENED);
  });

  it("populates successfulPushes when successfulPushAt is provided", () => {
    const result = branchMetricCycleFromPullRequest(
      pr(GitHubPRState.Open, false, null, null),
      PUSH
    );
    expect(result?.successfulPushes).toHaveLength(1);
    expect(result?.successfulPushes[0].occurredAt).toBe(PUSH);
  });

  it("produces empty successfulPushes when no push timestamp is provided", () => {
    const result = branchMetricCycleFromPullRequest(
      pr(GitHubPRState.Closed, false, null, TERMINAL),
      null
    );
    expect(result?.successfulPushes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// calculateBranchDetailMetrics — selectedCycle: null
// ---------------------------------------------------------------------------

describe("calculateBranchDetailMetrics with null selectedCycle", () => {
  it("returns Unavailable lead, abandonment, and idle when selectedCycle is null", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: 5,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: null,
    });
    expect(metrics.leadTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
    expect(metrics.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(metrics.idleTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });
});

// ---------------------------------------------------------------------------
// calculateBranchDetailMetrics — selectedPrAdditions / selectedPrDeletions
// ---------------------------------------------------------------------------

describe("calculateBranchDetailMetrics — locPerDollar edge cases", () => {
  it("returns Unavailable locPerDollar when selectedPrAdditions is null", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: null,
      selectedPrDeletions: 5,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: mergedCycle(),
    });
    expect(metrics.locPerDollar.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("returns Unavailable locPerDollar when selectedPrDeletions is null", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: null,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: mergedCycle(),
    });
    expect(metrics.locPerDollar.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("returns NotApplicable locPerDollar when cost is complete zero (non-partial)", () => {
    // totalCost.value === 0 but Complete (not Partial) → locPerDollar ≤ 0 → notApplicable
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: 5,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(), // no segments → totalCost = complete(0)
      selectedCycle: mergedCycle(),
    });
    expect(metrics.locPerDollar.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });

  it("returns CostIncomplete disclosure when cost is Partial and loc is complete", () => {
    const partialAttribution: BranchPhaseAttributionResult = {
      ...emptyAttribution(),
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 10,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 1,
        },
        {
          phase: BranchVisibleLifecyclePhase.Review,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
        {
          phase: BranchVisibleLifecyclePhase.Rework,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
      ],
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Partial,
        reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
        subtotalUsd: 10,
      },
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 100,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true, // loc IS complete
      phaseAttribution: partialAttribution,
      selectedCycle: mergedCycle(),
    });
    expect(metrics.locPerDollar.state).toBe(BranchMetricAvailability.Partial);
    expect(expectPartialMetric(metrics.locPerDollar).disclosure).toBe(
      BranchMetricDisclosure.CostIncomplete
    );
  });

  it("returns DefaultIncomplete disclosure when loc is incomplete and cost is complete", () => {
    const attribution: BranchPhaseAttributionResult = {
      ...emptyAttribution(),
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 5,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 1,
        },
        {
          phase: BranchVisibleLifecyclePhase.Review,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
        {
          phase: BranchVisibleLifecyclePhase.Rework,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
      ],
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Complete,
        subtotalUsd: 5,
      },
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 50,
      selectedPrDeletions: 0,
      selectedPrLocComplete: false, // loc is INCOMPLETE
      phaseAttribution: attribution,
      selectedCycle: mergedCycle(),
    });
    expect(metrics.locPerDollar.state).toBe(BranchMetricAvailability.Partial);
    expect(expectPartialMetric(metrics.locPerDollar).disclosure).toBe(
      BranchMetricDisclosure.DefaultIncomplete
    );
  });
});

// ---------------------------------------------------------------------------
// calculateOutcome edge cases (exercised through calculateBranchDetailMetrics)
// ---------------------------------------------------------------------------

describe("calculateBranchDetailMetrics — calculateOutcome edge cases", () => {
  it("returns Unavailable lead time for a Merged cycle with null terminalAt", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: {
        cycleId: "c1",
        openedAt: OPENED,
        terminalAt: null, // ← Merged but null terminalAt → unavailableOutcome
        outcome: BranchMetricPullRequestOutcome.Merged,
        successfulPushes: [],
      },
    });
    expect(metrics.leadTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
    expect(metrics.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    // span = null, idleApplicable = true → unavailable idle
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("skips a push anchor with null occurredAt", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: {
        cycleId: "c1",
        openedAt: OPENED,
        terminalAt: TERMINAL,
        outcome: BranchMetricPullRequestOutcome.Merged,
        successfulPushes: [
          { cycleId: "c1", occurredAt: null }, // null occurredAt → dropped
        ],
      },
    });
    // No valid anchor → startMs = Infinity → unavailableOutcome
    expect(metrics.leadTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("skips a push anchor whose occurredAt is after terminalAt", () => {
    const afterTerminal = "2026-08-02T00:00:00.000Z";
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: {
        cycleId: "c1",
        openedAt: OPENED,
        terminalAt: TERMINAL,
        outcome: BranchMetricPullRequestOutcome.Merged,
        successfulPushes: [
          { cycleId: "c1", occurredAt: afterTerminal }, // > terminalAtMs → dropped
        ],
      },
    });
    expect(metrics.leadTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });
});

// ---------------------------------------------------------------------------
// calculateIdle edge cases
// ---------------------------------------------------------------------------

describe("calculateBranchDetailMetrics — calculateIdle edge cases", () => {
  it("returns Unavailable idle when attribution coverage is Unavailable and span is non-null", () => {
    const unavailableAttrib: BranchPhaseAttributionResult = {
      ...emptyAttribution(),
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Unavailable,
        reason:
          BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
      },
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: unavailableAttrib,
      selectedCycle: mergedCycle(), // has valid push → span is non-null
    });
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("returns Unavailable idle for Partial coverage with a non-PricingIncomplete reason", () => {
    const partialOther: BranchPhaseAttributionResult = {
      ...emptyAttribution(),
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 2,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 1,
        },
        {
          phase: BranchVisibleLifecyclePhase.Review,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
        {
          phase: BranchVisibleLifecyclePhase.Rework,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
      ],
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Partial,
        reason: BranchPhaseAttributionCompletenessReason.CoverageCapped, // ← NOT PricingIncomplete
        subtotalUsd: 2,
      },
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: partialOther,
      selectedCycle: mergedCycle(),
    });
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("returns Unavailable idle when a segment has malformed (non-finite) bounds", () => {
    const malformedAttrib: BranchPhaseAttributionResult = {
      ...emptyAttribution(),
      segments: [
        {
          sessionId: "s1",
          sequence: 0,
          phase: BranchVisibleLifecyclePhase.Build,
          startMs: Number.NaN,
          endMs: Number.NaN,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          evidenceIds: [],
        },
      ],
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 1,
        },
        {
          phase: BranchVisibleLifecyclePhase.Review,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
        {
          phase: BranchVisibleLifecyclePhase.Rework,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
      ],
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: malformedAttrib,
      selectedCycle: mergedCycle(),
    });
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("returns Unavailable idle when a segment has inverted bounds (endMs < startMs)", () => {
    const t = Date.parse(PUSH);
    const invertedAttrib: BranchPhaseAttributionResult = {
      ...emptyAttribution(),
      segments: [
        {
          sessionId: "s1",
          sequence: 0,
          phase: BranchVisibleLifecyclePhase.Build,
          startMs: t + 1000,
          endMs: t, // inverted
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          evidenceIds: [],
        },
      ],
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 1,
        },
        {
          phase: BranchVisibleLifecyclePhase.Review,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
        {
          phase: BranchVisibleLifecyclePhase.Rework,
          estimatedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 0,
        },
      ],
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: invertedAttrib,
      selectedCycle: mergedCycle(),
    });
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });
});

// ---------------------------------------------------------------------------
// parseTimestamp — NaN arm (Number.isNaN(timestamp) → null)
// ---------------------------------------------------------------------------

describe("calculateBranchDetailMetrics — parseTimestamp NaN arm (non-null unparseable terminalAt)", () => {
  it("returns Unavailable lead time for a Merged cycle with a non-null, unparseable terminalAt", () => {
    // "bad-date" is non-null → parseTimestamp does NOT return early at the null check.
    // Date.parse("bad-date") = NaN → Number.isNaN(timestamp) → true → returns null.
    // terminalAtMs === null → unavailableOutcome covers the NaN arm (branch 46[0]).
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: emptyAttribution(),
      selectedCycle: {
        cycleId: "c1",
        openedAt: OPENED,
        terminalAt: "bad-date",
        outcome: BranchMetricPullRequestOutcome.Merged,
        successfulPushes: [],
      },
    });
    expect(metrics.leadTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });
});
