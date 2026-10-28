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
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  phaseAttributionSegment,
  rollupTotalUsd,
} from "./__tests__/branch-phase-attribution-fixture";
import {
  calculateBranchDetailMetrics,
  selectedCycleSuccessfulPushAt,
} from "./branch-detail-outcomes";

// Each call passes the fixture's own rollup total, which keeps these lead-time,
// idle and LOC cases on the reconciled path. Divergence between attributed and
// rollup cost is exercised in `branch-detail-cost-reconciliation.test.ts`.

const OPENED = "2026-08-01T10:00:00.000Z";
const PUSH = "2026-08-01T11:00:00.000Z";
const TERMINAL = "2026-08-01T13:00:00.000Z";

describe("canonical Branch Detail metrics", () => {
  it("produces Lead only for merged and unions clipped overlapping activity", () => {
    const unionAttribution = attribution([
      segment(BranchVisibleLifecyclePhase.Build, "10:30", "11:30", 6),
      segment(BranchVisibleLifecyclePhase.Review, "11:00", "12:00", 4),
      segment(BranchVisibleLifecyclePhase.Rework, "12:30", "13:30", 10),
    ]);
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 80,
      selectedPrDeletions: 20,
      selectedPrLocComplete: true,
      attributedCostUsd: rollupTotalUsd(unionAttribution),
      phaseAttribution: unionAttribution,
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
      attributedCostUsd: rollupTotalUsd(attribution([])),
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
      attributedCostUsd: rollupTotalUsd(attribution([])),
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
      attributedCostUsd: rollupTotalUsd(attribution([])),
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
      attributedCostUsd: rollupTotalUsd(attribution([])),
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
      attributedCostUsd: rollupTotalUsd(attribution([])),
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

  // The total is the branch's canonical attributed cost, which does not become
  // less known because phase attribution hit PricingIncomplete. The
  // incompleteness is real and is disclosed on the phase ROWS, which are the
  // rollup values and the thing that is actually incomplete.
  it("stars the phase rows, not the canonical total, when phase coverage is incomplete", () => {
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
      attributedCostUsd: rollupTotalUsd(partialAttribution),
      phaseAttribution: partialAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });
    expect(metrics.totalCostUsd).toEqual(complete(10));
    expect(metrics.phaseCostUsd.build.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(metrics.phaseCostUsd.review.state).toBe(
      BranchMetricAvailability.Partial
    );
    // The denominator is the exact attributed cost, so the ratio is not starred.
    expect(metrics.locPerDollar.state).toBe(BranchMetricAvailability.Complete);
    expect(metrics.idleTimeMs.state).toBe(BranchMetricAvailability.Complete);
  });

  it("keeps post-terminal Review in Branch cost but outside the outcome span", () => {
    const postTerminalAttribution = attribution([
      segment(BranchVisibleLifecyclePhase.Review, "13:30", "14:00", 5),
    ]);
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 10,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      attributedCostUsd: rollupTotalUsd(postTerminalAttribution),
      phaseAttribution: postTerminalAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });
    expect(metrics.totalCostUsd).toEqual(complete(5));
    expect(metrics.idleTimeMs).toEqual(complete(2 * 60 * 60 * 1000));
  });

  it("emits NoData for lifetime LOC per dollar when no qualifying Sessions exist", () => {
    const emptyAttribution = attribution([]);
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 0,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      qualifyingSessionCount: 0,
      attributedCostUsd: rollupTotalUsd(emptyAttribution),
      phaseAttribution: emptyAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });

    expect(metrics.locPerDollar.state).toBe(BranchMetricAvailability.NoData);
    expect(metrics.locPerDollar.value).toBeNull();
  });

  // The partial-zero case, flipped to the state this denominator produces. A
  // zero phase rollup under Partial attribution no longer blanks the ratio: the
  // branch's attributed cost is what answers, and $20 over 100 lines is 5 LOC/$
  // whatever the phase rows did with their share of it.
  it("computes the ratio from attributed cost when the partial phase rollup is zero", () => {
    const partialAttribution = attribution([]);
    partialAttribution.coverage = {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
      subtotalUsd: 0,
    };
    const metrics = calculateBranchDetailMetrics({
      selectedPrAdditions: 80,
      selectedPrDeletions: 20,
      selectedPrLocComplete: true,
      attributedCostUsd: 20,
      phaseAttribution: partialAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    });

    expect(metrics.locPerDollar).toEqual(complete(5));
  });

  // Every other case in this file feeds a numeric attributed cost, so the
  // denominator's own decline arms were never executed. Both flow through
  // `locPerDollarDenominator`, not the qualifying-Session early return.
  it.each([
    ["absent", null],
    ["negative", -5],
    ["non-finite", Number.POSITIVE_INFINITY],
  ])(
    "declines LOC per dollar when attributed cost is %s",
    (_label, attributedCostUsd) => {
      const metrics = calculateBranchDetailMetrics({
        selectedPrAdditions: 80,
        selectedPrDeletions: 20,
        selectedPrLocComplete: true,
        attributedCostUsd,
        phaseAttribution: attribution([
          segment(BranchVisibleLifecyclePhase.Build, "11:00", "12:00", 10),
        ]),
        selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
      });

      expect(metrics.locPerDollar.state).toBe(
        BranchMetricAvailability.Unavailable
      );
    }
  );

  // The zero-qualifying-Session arm used to answer from
  // `phaseAttribution.coverage`, so incomplete attribution turned an absent cost
  // into Unavailable and a settled one into NoData by a route the denominator
  // never saw. Both halves are now the denominator's call.
  it("answers the zero-Session case from the denominator, not phase coverage", () => {
    const partialAttribution = attribution([]);
    partialAttribution.coverage = {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
      subtotalUsd: 0,
    };
    const base = {
      selectedPrAdditions: 0,
      selectedPrDeletions: 0,
      selectedPrLocComplete: true,
      qualifyingSessionCount: 0,
      phaseAttribution: partialAttribution,
      selectedCycle: cycle(BranchMetricPullRequestOutcome.Merged),
    };

    // Partial attribution no longer forces Unavailable on a priced branch.
    expect(
      calculateBranchDetailMetrics({ ...base, attributedCostUsd: 20 })
        .locPerDollar.state
    ).toBe(BranchMetricAvailability.NoData);
    // ...and a complete attribution no longer rescues an absent cost.
    expect(
      calculateBranchDetailMetrics({ ...base, attributedCostUsd: null })
        .locPerDollar.state
    ).toBe(BranchMetricAvailability.Unavailable);
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
      attributedCostUsd: rollupTotalUsd(malformed),
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
        lifecycleEvent("2026-08-01T11:30:00.000Z", GIT_PUSH_METHOD),
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
        lifecycleEvent("2026-08-01T08:30:00.000Z", GIT_PUSH_METHOD),
        lifecycleEvent("2026-08-01T10:15:00.000Z", GIT_PUSH_METHOD),
        lifecycleEvent("2026-08-01T11:00:00.000Z", "gh_pr_create"),
        lifecycleEvent("2026-08-01T13:30:00.000Z", GIT_PUSH_METHOD),
      ])
    ).toBe("2026-08-01T10:15:00.000Z");
  });

  it("returns null without a collection or when the selected id is absent", () => {
    expect(
      selectedCycleSuccessfulPushAt(undefined, [], "2026-08-01T09:00:00.000Z")
    ).toBeNull();
    const collection = pullRequestCollection(
      [pullRequest("acme/web#1", OPENED, TERMINAL)],
      "acme/web#9"
    );
    expect(
      selectedCycleSuccessfulPushAt(
        collection,
        [lifecycleEvent("2026-08-01T10:30:00.000Z", GIT_PUSH_METHOD)],
        "2026-08-01T09:00:00.000Z"
      )
    ).toBeNull();
  });

  it("bounds the cycle by closedAt when the selected PR never merged", () => {
    const collection = pullRequestCollection([
      {
        ...pullRequest("acme/web#1", OPENED, TERMINAL),
        mergedAt: null,
        closedAt: "2026-08-01T11:00:00.000Z",
      },
    ]);
    expect(
      selectedCycleSuccessfulPushAt(collection, [
        lifecycleEvent("2026-08-01T11:30:00.000Z", GIT_PUSH_METHOD),
        lifecycleEvent("2026-08-01T10:30:00.000Z", GIT_PUSH_METHOD),
      ])
    ).toBe("2026-08-01T10:30:00.000Z");
    expect(
      selectedCycleSuccessfulPushAt(collection, [
        lifecycleEvent("2026-08-01T11:30:00.000Z", GIT_PUSH_METHOD),
      ])
    ).toBeNull();
  });

  it("returns null when the selected PR has no terminal timestamp", () => {
    const collection = pullRequestCollection([
      { ...pullRequest("acme/web#1", OPENED, TERMINAL), mergedAt: null },
    ]);
    expect(
      selectedCycleSuccessfulPushAt(
        collection,
        [lifecycleEvent("2026-08-01T10:30:00.000Z", GIT_PUSH_METHOD)],
        "2026-08-01T09:00:00.000Z"
      )
    ).toBeNull();
  });

  it("uses a closed-unmerged prior PR's closedAt as the prior-cycle bound", () => {
    const collection = pullRequestCollection(
      [
        {
          ...pullRequest(
            "acme/web#1",
            "2026-08-01T08:00:00.000Z",
            "2026-08-01T09:00:00.000Z"
          ),
          mergedAt: null,
          closedAt: "2026-08-01T09:00:00.000Z",
        },
        pullRequest("acme/web#2", OPENED, TERMINAL),
      ],
      "acme/web#2"
    );
    expect(
      selectedCycleSuccessfulPushAt(
        collection,
        [
          lifecycleEvent("2026-08-01T08:30:00.000Z", GIT_PUSH_METHOD),
          lifecycleEvent("2026-08-01T10:15:00.000Z", GIT_PUSH_METHOD),
        ],
        "2026-08-01T07:00:00.000Z"
      )
    ).toBe("2026-08-01T10:15:00.000Z");
  });

  it("counts a prior terminal before the selected terminal when openedAt is unparseable", () => {
    const collection = pullRequestCollection(
      [
        pullRequest(
          "acme/web#1",
          "2026-08-01T08:00:00.000Z",
          "2026-08-01T11:00:00.000Z"
        ),
        pullRequest("acme/web#2", "not-a-timestamp", TERMINAL),
      ],
      "acme/web#2"
    );
    expect(
      selectedCycleSuccessfulPushAt(collection, [
        lifecycleEvent("2026-08-01T10:30:00.000Z", GIT_PUSH_METHOD),
        lifecycleEvent("2026-08-01T12:00:00.000Z", GIT_PUSH_METHOD),
      ])
    ).toBe("2026-08-01T12:00:00.000Z");
  });

  it("ignores other PRs that terminate after the selected PR, keeping the first-cycle fallback", () => {
    const collection = pullRequestCollection(
      [
        pullRequest(
          "acme/web#2",
          "2026-08-01T12:00:00.000Z",
          "2026-08-01T15:00:00.000Z"
        ),
        pullRequest("acme/web#1", OPENED, TERMINAL),
      ],
      "acme/web#1"
    );
    expect(
      selectedCycleSuccessfulPushAt(collection, [], "2026-08-01T09:00:00.000Z")
    ).toBe("2026-08-01T09:00:00.000Z");
  });

  it("skips push events without an observedAt", () => {
    const collection = pullRequestCollection([
      pullRequest("acme/web#1", OPENED, TERMINAL),
    ]);
    expect(
      selectedCycleSuccessfulPushAt(collection, [
        {
          kind: BranchLifecycleBoundaryKind.BranchWrite,
          observedAt: null,
          method: GIT_PUSH_METHOD,
        },
        lifecycleEvent("2026-08-01T12:00:00.000Z", GIT_PUSH_METHOD),
      ])
    ).toBe("2026-08-01T12:00:00.000Z");
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
  return phaseAttributionSegment({
    sessionId: `${phase}-${start}`,
    phase,
    startMs: Date.parse(`2026-08-01T${start}:00.000Z`),
    endMs: Date.parse(`2026-08-01T${end}:00.000Z`),
    estimatedCostUsd,
  });
}

function complete(value: number) {
  return { state: BranchMetricAvailability.Complete, value };
}

const GIT_PUSH_METHOD = BRANCH_PUSH_METHOD_VALUES[0];
