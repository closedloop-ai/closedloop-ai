import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchMetricAvailability,
  BranchMetricPullRequestOutcome,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  calculateBranchDetailMetrics,
  selectedCycleSuccessfulPushAt,
} from "./branch-detail-outcomes";

const OPENED = "2026-08-01T10:00:00.000Z";
const PUSH = "2026-08-01T11:00:00.000Z";
const TERMINAL = "2026-08-01T13:00:00.000Z";

describe("canonical Branch Detail metrics", () => {
  it("produces Lead only for merged and unions clipped overlapping activity", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 80,
      selectedPrDeletions: 20,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([
        segment(BranchVisibleLifecyclePhase.Build, "10:30", "11:30", 6),
        segment(BranchVisibleLifecyclePhase.Review, "11:00", "12:00", 4),
        segment(BranchVisibleLifecyclePhase.Rework, "12:30", "13:30", 10),
      ]),
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });

    expect(metrics.leadTimeMs).toEqual(complete(2 * 60 * 60 * 1000));
    expect(metrics.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    // Outcome 11:00-13:00; unioned active is 11:00-12:00 + 12:30-13:00.
    expect(metrics.idleTimeMs).toEqual(complete(30 * 60 * 1000));
    expect(metrics.totalCostUsd).toEqual(complete(20));
    expect(metrics.locPerDollar).toEqual(complete(5));
  });

  it("produces Abandonment only for closed-unmerged", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 1,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([]),
      selectedCycle: cycle(BranchMetricPullRequestOutcome.ClosedUnmerged),
    });
    expect(metrics.leadTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    expect(metrics.abandonmentTimeMs).toEqual(complete(2 * 60 * 60 * 1000));
  });

  it("accepts a cycle-specific contributing push before the PR opens", () => {
    const selectedCycle = cycle(BranchMetricPullRequestOutcome.Merged);
    selectedCycle.successfulPushes = [
      {
        cycleId: selectedCycle.cycleId,
        occurredAt: "2026-08-01T09:00:00.000Z",
      },
    ];
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 1,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([]),
      selectedCycle,
    });
    expect(metrics.leadTimeMs).toEqual(complete(4 * 60 * 60 * 1000));
  });

  it.each([
    BranchMetricPullRequestOutcome.Open,
    BranchMetricPullRequestOutcome.Draft,
  ])("marks both outcomes N/A for %s", (outcome) => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 1,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([]),
      selectedCycle: cycle(outcome),
    });
    expect(metrics.leadTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    expect(metrics.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    expect(metrics.idleTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });

  it("never anchors the latest cycle from another cycle's push", () => {
    const selectedCycle = cycle(BranchMetricPullRequestOutcome.Merged);
    selectedCycle.successfulPushes = [
      { cycleId: "old-cycle", occurredAt: PUSH },
    ];
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 1,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([]),
      selectedCycle,
    });
    expect(metrics.leadTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
    expect(metrics.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("preserves closed-unmerged applicability when its push anchor is missing", () => {
    const selectedCycle = cycle(BranchMetricPullRequestOutcome.ClosedUnmerged);
    selectedCycle.successfulPushes = [];
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 1,
      selectedPrDeletions: 1,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([]),
      selectedCycle,
    });
    expect(metrics.leadTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
    expect(metrics.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Unavailable);
  });

  it("stars every cost and dependent ratio when phase coverage is incomplete", () => {
    const partialAttribution = attribution([
      segment(BranchVisibleLifecyclePhase.Build, "11:00", "12:00", 10),
    ]);
    partialAttribution.coverage = {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
      subtotalUsd: 10,
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 50,
      selectedPrDeletions: 50,
      selectedPrLocComplete: true,
      phaseAttribution: partialAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });
    expect(metrics.totalCostUsd.state).toBe(BranchMetricAvailability.Partial);
    expect(metrics.phaseCostUsd.build.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(metrics.phaseCostUsd.review.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(metrics.locPerDollar.state).toBe(BranchMetricAvailability.Partial);
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Complete);
  });

  it("keeps post-terminal Review in Branch cost but outside the outcome span", () => {
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: attribution([
        segment(BranchVisibleLifecyclePhase.Review, "13:30", "14:00", 5),
      ]),
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });
    expect(metrics.totalCostUsd).toEqual(complete(5));
    expect(metrics.idleTimeMs).toEqual(complete(2 * 60 * 60 * 1000));
  });

  it("does not treat a partial zero cost as a settled zero denominator", () => {
    const partialAttribution = attribution([]);
    partialAttribution.coverage = {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
      subtotalUsd: 0,
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: partialAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });
    expect(metrics.locPerDollar.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("degrades malformed rollup costs instead of emitting complete NaN", () => {
    const valid = attribution([
      segment(BranchVisibleLifecyclePhase.Build, "11:00", "12:00", 10),
    ]);
    const malformed: BranchPhaseAttributionResult = {
      ...valid,
      rollups: valid.rollups.map((rollup) => ({
        ...rollup,
        estimatedCostUsd: Number.NaN,
      })),
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      phaseAttribution: malformed,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });
    expect(metrics.totalCostUsd.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(metrics.locPerDollar.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

describe("selectedCycleSuccessfulPushAt", () => {
  it("returns the earliest persisted successful push in the first PR cycle", () => {
    const collection = pullRequestCollection([
      pullRequest("acme/web#1", OPENED, TERMINAL),
    ]);

    expect(
      selectedCycleSuccessfulPushAt(collection, [
        lifecycleEvent("2026-08-01T10:30:00.000Z", "git_commit"),
        lifecycleEvent("2026-08-01T11:30:00.000Z", "git_push"),
        lifecycleEvent("2026-08-01T10:45:00.000Z", "gh_pr_create"),
      ])
    ).toBe("2026-08-01T10:45:00.000Z");
  });

  it("uses the persisted Branch first-push fallback only for the first cycle", () => {
    const firstCycle = pullRequestCollection([
      pullRequest("acme/web#1", OPENED, TERMINAL),
    ]);
    expect(
      selectedCycleSuccessfulPushAt(firstCycle, [], "2026-08-01T09:00:00.000Z")
    ).toBe("2026-08-01T09:00:00.000Z");

    const laterCycle = pullRequestCollection(
      [
        pullRequest(
          "acme/web#1",
          "2026-08-01T08:00:00.000Z",
          "2026-08-01T09:00:00.000Z"
        ),
        pullRequest(
          "acme/web#2",
          "2026-08-01T10:00:00.000Z",
          "2026-08-01T13:00:00.000Z"
        ),
      ],
      "acme/web#2"
    );
    expect(
      selectedCycleSuccessfulPushAt(laterCycle, [], "2026-08-01T07:00:00.000Z")
    ).toBeNull();
  });

  it("excludes prior-cycle pushes and chooses the first push after its terminal", () => {
    const collection = pullRequestCollection(
      [
        pullRequest(
          "acme/web#1",
          "2026-08-01T08:00:00.000Z",
          "2026-08-01T09:00:00.000Z"
        ),
        pullRequest(
          "acme/web#2",
          "2026-08-01T10:00:00.000Z",
          "2026-08-01T13:00:00.000Z"
        ),
      ],
      "acme/web#2"
    );

    expect(
      selectedCycleSuccessfulPushAt(collection, [
        lifecycleEvent("2026-08-01T08:30:00.000Z", "git_push"),
        lifecycleEvent("2026-08-01T10:15:00.000Z", "git_push"),
        lifecycleEvent("2026-08-01T11:00:00.000Z", "gh_pr_create"),
        lifecycleEvent("2026-08-01T13:30:00.000Z", "git_push"),
      ])
    ).toBe("2026-08-01T10:15:00.000Z");
  });
});

function cycle(outcome: BranchMetricPullRequestOutcome) {
  return {
    cycleId: "latest-cycle",
    openedAt: OPENED,
    terminalAt:
      outcome === BranchMetricPullRequestOutcome.Open ||
      outcome === BranchMetricPullRequestOutcome.Draft
        ? null
        : TERMINAL,
    outcome,
    successfulPushes: [{ cycleId: "latest-cycle", occurredAt: PUSH }],
  };
}

function pullRequestCollection(
  items: BranchAssociatedPullRequestCollection["items"],
  selectedId: string = items[0]?.id ?? ""
): BranchAssociatedPullRequestCollection {
  return {
    items,
    selectedId,
    selectionReason: BranchAssociatedPullRequestSelectionReason.Explicit,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  };
}

function pullRequest(id: string, openedAt: string, mergedAt: string) {
  const [repositoryFullName = "acme/web", number = "1"] = id.split("#");
  return {
    id,
    repositoryFullName,
    number: Number(number),
    title: null,
    url: null,
    state: GitHubPRState.Merged,
    isDraft: false,
    reviewDecision: null,
    openedAt,
    closedAt: null,
    mergedAt,
  };
}

function lifecycleEvent(observedAt: string, method: string) {
  return {
    kind: BranchLifecycleBoundaryKind.BranchWrite,
    observedAt,
    method,
  };
}

function attribution(
  segments: BranchPhaseAttributionResult["segments"]
): BranchPhaseAttributionResult {
  const phases = Object.values(BranchVisibleLifecyclePhase);
  return {
    segments,
    rollups: phases.map((phase) => ({
      phase,
      estimatedCostUsd: segments
        .filter((item) => item.phase === phase)
        .reduce((sum, item) => sum + item.estimatedCostUsd, 0),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: segments.reduce(
        (sum, item) => sum + item.estimatedCostUsd,
        0
      ),
    },
  };
}

function segment(
  phase: BranchVisibleLifecyclePhase,
  start: string,
  end: string,
  estimatedCostUsd: number
) {
  return {
    sessionId: `${phase}-${start}`,
    sequence: 0,
    phase,
    startMs: Date.parse(`2026-08-01T${start}:00.000Z`),
    endMs: Date.parse(`2026-08-01T${end}:00.000Z`),
    estimatedCostUsd,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    evidenceIds: [],
  };
}

function complete(value: number) {
  return { state: BranchMetricAvailability.Complete, value };
}
