import assert from "node:assert/strict";
import test from "node:test";
import {
  BranchLifecycleBoundaryKind,
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { exactCohortMetricParityExpectation } from "@repo/lib/branches/__tests__/exact-cohort-metric-parity-fixture";
import {
  attachDesktopCanonicalDetailMetrics,
  buildPhaseEvidence,
  projectDesktopCanonicalMetrics,
} from "../src/main/branch/branch-canonical-metric-projection.js";
import type { BranchPrRow } from "../src/main/database/branch-reads.js";
import { makeBranchRowFixture } from "./shared-branches-test-helpers.js";

test("desktop canonical metrics use the full persisted cohort", () => {
  const metrics = projectDesktopCanonicalMetrics(
    [
      makeBranchRowFixture({
        id: "active-branch",
        status: BranchStatus.Open,
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      }),
      makeBranchRowFixture({
        id: "merged-branch",
        status: BranchStatus.Merged,
        lastActivityAt: "2026-07-21T00:00:00.000Z",
      }),
    ],
    [
      {
        repoFullName: "acme/web",
        branchName: "feature/active-branch",
        sessionId: "session-1",
        sessionName: "work",
        isPrimary: true,
        observedAt: "2026-08-02T00:00:00.000Z",
        activityAt: "2026-08-01T12:00:00.000Z",
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
        ownerUserId: null,
      },
      {
        repoFullName: "acme/web",
        branchName: "feature/merged-branch",
        sessionId: "session-scan-only",
        sessionName: "scan-only",
        isPrimary: false,
        observedAt: "2026-08-02T12:00:00.000Z",
        activityAt: "2026-08-02T12:00:00.000Z",
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
        ownerUserId: null,
      },
    ],
    [pullRequest()],
    {
      startDate: "2026-07-27T00:00:00.000Z",
      endDate: "2026-08-03T00:00:00.000Z",
    },
    new Date("2026-08-03T00:00:00.000Z"),
    [usageEvent()],
    new Map([["session-1", 2]]),
    phaseEvidence()
  );

  assert.equal(metrics.cohortSize, 2);
  assert.equal(metrics.activeBranches.current.value, 1);
  assert.equal(metrics.medianPrSize.current.value, 12);
  // Session end/start is not authoritative Last-active evidence.
  assert.equal(metrics.lastActiveAt.value, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(metrics.aiSpendUsd.current, {
    state: BranchMetricAvailability.Partial,
    value: 5,
    disclosure: BranchMetricDisclosure.CostIncomplete,
  });
});

test("desktop all-time spend uses canonical event-time rows", () => {
  const metrics = projectDesktopCanonicalMetrics(
    [makeBranchRowFixture({ id: "active-branch" })],
    [
      {
        repoFullName: "acme/web",
        branchName: "feature/active-branch",
        sessionId: "session-1",
        sessionName: "work",
        isPrimary: true,
        observedAt: "2026-08-02T00:00:00.000Z",
        activityAt: "2026-08-01T12:00:00.000Z",
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
        ownerUserId: null,
      },
    ],
    [],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [usageEvent()],
    new Map([["session-1", 1]]),
    phaseEvidence()
  );

  assert.equal(metrics.aiSpendUsd.current.value, 10);
});

test("desktop matches the exact-cohort cross-surface metric fixture", () => {
  const branchName = "feature/shared";
  const metrics = projectDesktopCanonicalMetrics(
    [
      makeBranchRowFixture({
        id: "shared",
        branchName,
        status: BranchStatus.Merged,
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      }),
    ],
    [
      {
        repoFullName: "acme/web",
        branchName,
        sessionId: "session-1",
        sessionName: "work",
        isPrimary: true,
        observedAt: "2026-08-01T00:00:00.000Z",
        activityAt: "2026-08-01T00:01:00.000Z",
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
        ownerUserId: null,
      },
    ],
    [{ ...pullRequest(), branchName }],
    {
      startDate: "2026-07-27T00:00:00.000Z",
      endDate: "2026-08-03T00:00:00.000Z",
    },
    new Date("2026-08-03T00:00:00.000Z"),
    [usageEvent()],
    new Map([["session-1", 1]]),
    phaseEvidence(branchName)
  );

  assert.deepEqual(
    metricParitySubset(metrics),
    exactCohortMetricParityExpectation
  );
});

test("desktop all-time spend rejects undated cost evidence", () => {
  const metrics = projectDesktopCanonicalMetrics(
    [makeBranchRowFixture({ id: "active-branch" })],
    [
      {
        repoFullName: "acme/web",
        branchName: "feature/active-branch",
        sessionId: "session-1",
        sessionName: "work",
        isPrimary: true,
        observedAt: "2026-08-02T00:00:00.000Z",
        activityAt: "2026-08-01T12:00:00.000Z",
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
        ownerUserId: null,
      },
    ],
    [],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [{ ...usageEvent(), createdAt: null }],
    new Map([["session-1", 1]]),
    phaseEvidence()
  );

  assert.equal(
    metrics.aiSpendUsd.current.state,
    BranchMetricAvailability.Unavailable
  );
});

test("desktop canonical median consumes exact cloud-hydrated selected-PR LOC", () => {
  const preHydrationItem = makeBranchRowFixture({
    id: "merged-branch",
    status: BranchStatus.Merged,
    prNumber: 1,
  });
  const metrics = projectDesktopCanonicalMetrics(
    [
      {
        ...preHydrationItem,
        additions: 140,
        deletions: 10,
        mergedAt: "2026-07-20T00:00:00.000Z",
      },
    ],
    [],
    [
      {
        ...pullRequest(),
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
      },
    ],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [],
    new Map(),
    undefined,
    [preHydrationItem]
  );

  assert.equal(metrics.medianPrSize.current.value, 150);
});

test("desktop canonical median consumes a cloud-only selected merged PR", () => {
  const preHydrationItem = makeBranchRowFixture({
    id: "cloud-only-branch",
    status: BranchStatus.Draft,
  });
  const metrics = projectDesktopCanonicalMetrics(
    [
      {
        ...preHydrationItem,
        status: BranchStatus.Merged,
        prNumber: 7,
        prState: GitHubPRState.Merged,
        mergedAt: "2026-07-20T00:00:00.000Z",
        additions: 140,
        deletions: 10,
      },
    ],
    [],
    [],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [],
    new Map(),
    undefined,
    [preHydrationItem]
  );

  assert.equal(metrics.medianPrSize.current.value, 150);
});

test("desktop canonical metrics apply non-date cohort filters before aggregation", () => {
  const metrics = projectDesktopCanonicalMetrics(
    [
      makeBranchRowFixture({ id: "open", status: BranchStatus.Open }),
      makeBranchRowFixture({
        id: "merged",
        branchName: "feature/merged",
        status: BranchStatus.Merged,
      }),
    ],
    [],
    [],
    { status: BranchStatus.Open },
    new Date("2026-08-03T00:00:00.000Z")
  );

  assert.equal(metrics.cohortSize, 1);
  assert.equal(metrics.activeBranches.current.value, 1);
});

test("desktop canonical metrics keep cohort and PR completeness independent", () => {
  const item = makeBranchRowFixture({ id: "known-branch" });
  const metrics = projectDesktopCanonicalMetrics(
    [item],
    [],
    [],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [],
    new Map(),
    undefined,
    [item],
    false,
    false
  );

  assert.equal(
    metrics.activeBranches.current.state,
    BranchMetricAvailability.Unavailable
  );
  assert.equal(
    metrics.medianPrSize.current.state,
    BranchMetricAvailability.Unavailable
  );
  assert.equal(
    metrics.mergeRatePct.current.state,
    BranchMetricAvailability.Unavailable
  );
});

test("capped phase evidence remains explicit at the projection boundary", () => {
  for (const [activityCapped, lifecycleCapped, admission] of [
    [true, false, { admitted: 1, canonical: 1 }],
    [false, true, { admitted: 1, canonical: 1 }],
    [false, false, { admitted: 0, canonical: 1 }],
  ] as const) {
    const evidence = buildPhaseEvidence(
      { rows: [], capped: activityCapped },
      { rows: [], capped: lifecycleCapped },
      admission
    );

    assert.deepEqual(evidence.coverageReasons, [
      BranchPhaseAttributionCompletenessReason.CoverageCapped,
    ]);
  }

  assert.deepEqual(
    buildPhaseEvidence(
      { rows: [], capped: false },
      { rows: [], capped: false },
      { admitted: 1, canonical: 1 }
    ).coverageReasons,
    []
  );
});

test("desktop detail uses selected-PR LOC instead of Branch LOC", () => {
  const detail: Pick<
    BranchPageDetail,
    "associatedPullRequests" | "phaseAttribution" | "canonicalMetrics"
  > & { additions: number; deletions: number } = {
    additions: 1000,
    deletions: 1000,
    associatedPullRequests: {
      items: [
        {
          id: "acme/web#1",
          repositoryFullName: "acme/web",
          number: 1,
          title: null,
          url: null,
          state: GitHubPRState.Merged,
          isDraft: false,
          reviewDecision: null,
          openedAt: "2026-07-30T00:00:00.000Z",
          closedAt: "2026-08-01T00:00:00.000Z",
          mergedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      selectedId: "acme/web#1",
      selectionReason:
        BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedDesktop,
      },
    },
    phaseAttribution: {
      segments: [],
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 20,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 0,
          sessionCount: 1,
        },
      ],
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Complete,
        subtotalUsd: 20,
      },
    },
  };
  const selectedPr = {
    ...pullRequest(),
    branchName: "feature/active-branch",
    linesAdded: 50,
    linesRemoved: 50,
  };

  attachDesktopCanonicalDetailMetrics(detail, [selectedPr]);

  assert.equal(detail.canonicalMetrics?.locPerDollar.value, 5);
});

function pullRequest(): BranchPrRow {
  return {
    repoFullName: "acme/web",
    branchName: "feature/merged-branch",
    prNumber: 1,
    prUrl: null,
    title: null,
    state: GitHubPRState.Merged,
    isDraft: false,
    mergedAt: "2026-08-01T00:00:00.000Z",
    closedAt: "2026-08-01T00:00:00.000Z",
    openedAt: "2026-07-30T00:00:00.000Z",
    observedAt: "2026-08-01T01:00:00.000Z",
    linesAdded: 10,
    linesRemoved: 2,
    filesChanged: 1,
  };
}

function usageEvent() {
  return {
    eventRowId: "1",
    eventFingerprint: "event-1",
    sessionId: "session-1",
    model: "test-model",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    billingMode: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    costUsdEstimated: 10,
  };
}

function phaseEvidence(branchName = "feature/active-branch") {
  return {
    activitySegmentRows: [
      {
        sessionId: "session-1",
        phase: "implement",
        startMs: Date.parse("2026-08-01T00:00:00.000Z"),
        endMs: Date.parse("2026-08-01T00:01:00.000Z"),
        confidence: 1,
      },
    ],
    lifecycleEventRows: [
      {
        repoFullName: "acme/web",
        branchName,
        sessionId: "session-1",
        sessionStartedAt: "2026-08-01T00:00:00.000Z",
        sessionEndedAt: "2026-08-01T00:01:00.000Z",
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: "2026-08-01T00:00:30.000Z",
        evidenceId: "push-1",
        method: "git_push",
      },
    ],
  };
}

function metricParitySubset(
  metrics: ReturnType<typeof projectDesktopCanonicalMetrics>
) {
  return {
    cohortSize: metrics.cohortSize,
    medianPrSize: metrics.medianPrSize.current,
    aiSpendUsd: metrics.aiSpendUsd.current,
    mergeRatePct: metrics.mergeRatePct.current,
    activeComparisonState: metrics.activeBranches.comparison?.deltaPct.state,
    locPerDollarState: metrics.locPerDollar.current.state,
  };
}
