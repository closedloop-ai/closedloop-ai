import assert from "node:assert/strict";
import {
  BranchLifecycleBoundaryKind,
  type BranchPageDetail,
  BranchStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { exactCohortMetricParityExpectation } from "@repo/lib/branches/__tests__/exact-cohort-metric-parity-fixture";
import { costFactsFromContributions } from "@repo/lib/branches/branch-cost-facts-from-contributions";
import { resolveCanonicalBranchMetricWindows } from "@repo/lib/branches/branch-list-metric-projection";
import { BranchPublicationLocSource } from "@repo/lib/branches/branch-publication-loc";
import { branchMetricFactWindows } from "@repo/lib/branches/branch-pull-request-metrics";
import { test } from "vitest";
import {
  attachDesktopCanonicalDetailMetrics,
  projectDesktopCanonicalMetrics,
} from "../src/main/branch/branch-canonical-metric-projection.js";
import { buildPhaseEvidence } from "../src/main/branch/branch-canonical-phase-evidence.js";
import { desktopPublicationLocEvidence } from "../src/main/branch/branch-publication-loc-projection.js";
import type { BranchLinkRow } from "../src/main/database/branch-reads.js";
import {
  makeBranchPrRowFixture,
  makeBranchRowFixture,
} from "./shared-branches-test-helpers.js";

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
        priority: null,
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
        priority: null,
      },
    ],
    [makeBranchPrRowFixture()],
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
});

test("desktop list LOC per $ counts a visible shared Session once while LOC stays windowed", () => {
  const recentBranchName = "feature/recent-shared-session";
  const olderBranchName = "feature/older-shared-session";
  const recent = makeBranchRowFixture({
    id: encodeBranchId({
      repoFullName: "acme/web",
      branchName: recentBranchName,
    }),
    repoFullName: "acme/web",
    branchName: recentBranchName,
    status: BranchStatus.Merged,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
  });
  const older = makeBranchRowFixture({
    id: encodeBranchId({
      repoFullName: "acme/web",
      branchName: olderBranchName,
    }),
    repoFullName: "acme/web",
    branchName: olderBranchName,
    status: BranchStatus.Merged,
    lastActivityAt: "2026-06-15T00:00:00.000Z",
  });
  const links = [
    {
      ...publicationLink(recentBranchName),
      successfulPushAt: "2026-07-31T00:00:00.000Z",
    },
    {
      ...publicationLink(olderBranchName),
      successfulPushAt: "2026-06-14T00:00:00.000Z",
    },
  ];
  const metrics = projectDesktopCanonicalMetrics(
    [recent],
    links,
    [
      {
        ...makeBranchPrRowFixture(),
        branchName: recentBranchName,
        prNumber: 10,
        mergedAt: "2026-08-01T00:00:00.000Z",
        linesAdded: 500,
        linesRemoved: 500,
      },
    ],
    {
      startDate: "2026-07-04T00:00:00.000Z",
      endDate: "2026-08-03T00:00:00.000Z",
    },
    new Date("2026-08-03T00:00:00.000Z"),
    [{ ...usageEvent(), costUsdEstimated: 100 }],
    new Map([["session-1", 2]]),
    {
      activitySegmentRows: [activitySegment("session-1")],
      lifecycleEventRows: [
        lifecycleEvent(recentBranchName, "acme/web", "session-1", "push-1"),
        lifecycleEvent(olderBranchName, "acme/web", "session-1", "push-2"),
      ],
    },
    true,
    true,
    [recent, older],
    links,
    true
  );

  assert.deepEqual(metrics.locPerDollar.current, {
    state: BranchMetricAvailability.Complete,
    value: 10,
  });
});

test("desktop matches the exact-cohort cross-surface metric fixture", () => {
  const branchName = "feature/shared";
  const metrics = projectDesktopCanonicalMetrics(
    [
      makeBranchRowFixture({
        id: encodeBranchId({ repoFullName: "acme/web", branchName }),
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
        priority: null,
      },
    ],
    [{ ...makeBranchPrRowFixture(), branchName }],
    {
      startDate: "2026-07-27T00:00:00.000Z",
      endDate: "2026-08-03T00:00:00.000Z",
    },
    new Date("2026-08-03T00:00:00.000Z"),
    [usageEvent()],
    new Map([["session-1", 1]]),
    phaseEvidence(branchName),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    aiSpendFactsOf(usageEvent().costUsdEstimated)
  );

  assert.deepEqual(
    metricParitySubset(metrics),
    exactCohortMetricParityExpectation
  );
});

test("desktop canonical metrics bucket same-name branches by repository", () => {
  const branchName = "feature/shared-name";
  const webBranchId = encodeBranchId({
    repoFullName: "acme/web",
    branchName,
  });
  const apiBranchId = encodeBranchId({
    repoFullName: "acme/api",
    branchName,
  });
  const metrics = projectDesktopCanonicalMetrics(
    [
      makeBranchRowFixture({
        id: webBranchId,
        repoFullName: "acme/web",
        branchName,
      }),
      makeBranchRowFixture({
        id: apiBranchId,
        repoFullName: "acme/api",
        branchName,
      }),
    ],
    [
      { ...publicationLink(branchName), sessionId: "session-web" },
      {
        ...publicationLink(branchName),
        repoFullName: "acme/api",
        sessionId: "session-api",
      },
    ],
    [
      {
        ...makeBranchPrRowFixture(),
        repoFullName: "acme/web",
        branchName,
        prNumber: 10,
        linesAdded: 10,
        linesRemoved: 2,
      },
      {
        ...makeBranchPrRowFixture(),
        repoFullName: "acme/api",
        branchName,
        prNumber: 20,
        linesAdded: 100,
        linesRemoved: 20,
      },
    ],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [
      {
        ...usageEvent(),
        eventRowId: "event-web-row",
        eventFingerprint: "event-web",
        sessionId: "session-web",
        costUsdEstimated: 1,
      },
      {
        ...usageEvent(),
        eventRowId: "event-api-row",
        eventFingerprint: "event-api",
        sessionId: "session-api",
        costUsdEstimated: 2,
      },
    ],
    new Map([
      ["session-web", 1],
      ["session-api", 1],
    ]),
    {
      activitySegmentRows: [
        activitySegment("session-web"),
        activitySegment("session-api"),
      ],
      lifecycleEventRows: [
        lifecycleEvent(branchName, "acme/web", "session-web", "push-web"),
        lifecycleEvent(branchName, "acme/api", "session-api", "push-api"),
      ],
    }
  );

  assert.equal(metrics.medianPrSize.current.value, 66);
});

test("desktop never relabels selected Branch-row LOC as publication evidence", () => {
  const branchName = "feature/cloud-only";
  const item = makeBranchRowFixture({
    id: encodeBranchId({ repoFullName: "acme/web", branchName }),
    branchName,
    status: BranchStatus.Merged,
    prNumber: 7,
    prState: GitHubPRState.Merged,
    mergedAt: "2026-07-20T00:00:00.000Z",
    additions: 140,
    deletions: 10,
  });

  const evidence = desktopPublicationLocEvidence([item], [], []);

  assert.equal(evidence.contributions.length, 0);
  assert.deepEqual(evidence.coverageGaps, [
    {
      sourceEventId: `${item.id}:hydrated-merged-pr:7`,
      occurredAt: "2026-07-20T00:00:00.000Z",
    },
  ]);
  assert.equal(evidence.coverageComplete, false);
  assert.deepEqual(evidence.completeBranchIds, []);
});

test("desktop keeps a successful push incomplete when only an open PR row exists", () => {
  const item = makeBranchRowFixture({
    id: encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/open-pr",
    }),
    branchName: "feature/open-pr",
  });
  const openPullRequest = {
    ...makeBranchPrRowFixture(),
    branchName: item.branchName,
    state: GitHubPRState.Open,
    mergedAt: null,
    closedAt: null,
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
  };

  const evidence = desktopPublicationLocEvidence(
    [item],
    [publicationLink(item.branchName)],
    [openPullRequest]
  );

  assert.deepEqual(evidence.contributions, []);
  assert.deepEqual(evidence.coverageGaps, [
    {
      sourceEventId: `${item.id}:successful-push`,
      occurredAt: "2026-08-02T00:00:00.000Z",
    },
  ]);
  assert.equal(evidence.coverageComplete, false);
  assert.deepEqual(evidence.completeBranchIds, []);
});

test("desktop does not render a confident zero for a pushed branch with only an open PR", () => {
  const branchName = "feature/open-pr";
  const item = makeBranchRowFixture({
    id: encodeBranchId({ repoFullName: "acme/web", branchName }),
    branchName,
  });
  const metrics = projectDesktopCanonicalMetrics(
    [item],
    [publicationLink(branchName)],
    [
      {
        ...makeBranchPrRowFixture(),
        branchName,
        state: GitHubPRState.Open,
        mergedAt: null,
        closedAt: null,
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
      },
    ],
    {},
    new Date("2026-08-03T00:00:00.000Z"),
    [usageEvent()],
    new Map([["session-1", 1]]),
    phaseEvidence(branchName)
  );

  assert.deepEqual(metrics.locPerDollar.current, {
    state: BranchMetricAvailability.Unavailable,
    value: null,
  });
});

test("desktop does not let merged-PR LOC certify an unrepresented push", () => {
  const item = makeBranchRowFixture({
    id: encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/merged-pr-and-push",
    }),
    branchName: "feature/merged-pr-and-push",
  });
  const mergedPullRequest = {
    ...makeBranchPrRowFixture(),
    branchName: item.branchName,
  };

  const evidence = desktopPublicationLocEvidence(
    [item],
    [publicationLink(item.branchName)],
    [mergedPullRequest]
  );

  assert.equal(evidence.contributions.length, 1);
  assert.equal(
    evidence.contributions[0]?.source,
    BranchPublicationLocSource.MergedPullRequest
  );
  assert.deepEqual(evidence.coverageGaps, [
    {
      sourceEventId: `${item.id}:successful-push`,
      occurredAt: "2026-08-02T00:00:00.000Z",
    },
  ]);
  assert.equal(evidence.coverageComplete, false);
});

test("desktop accepts merged-PR LOC that follows the latest successful push", () => {
  const item = makeBranchRowFixture({
    id: encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/push-then-merge",
    }),
    branchName: "feature/push-then-merge",
  });
  const link = publicationLink(item.branchName);
  link.successfulPushAt = "2026-07-31T00:00:00.000Z";

  const evidence = desktopPublicationLocEvidence(
    [item],
    [link],
    [{ ...makeBranchPrRowFixture(), branchName: item.branchName }]
  );

  assert.equal(evidence.contributions.length, 1);
  assert.deepEqual(evidence.coverageGaps, []);
  assert.equal(evidence.coverageComplete, true);
  assert.deepEqual(evidence.completeBranchIds, [item.id]);
});

test("desktop publication LOC gaps bucket same-name branches by repository", () => {
  const branchName = "feature/shared-name";
  const webBranchId = encodeBranchId({
    repoFullName: "acme/web",
    branchName,
  });
  const apiBranchId = encodeBranchId({
    repoFullName: "acme/api",
    branchName,
  });

  const evidence = desktopPublicationLocEvidence(
    [
      makeBranchRowFixture({
        id: webBranchId,
        repoFullName: "acme/web",
        branchName,
      }),
      makeBranchRowFixture({
        id: apiBranchId,
        repoFullName: "acme/api",
        branchName,
      }),
    ],
    [
      { ...publicationLink(branchName), sessionId: "session-web" },
      {
        ...publicationLink(branchName),
        repoFullName: "acme/api",
        hasLocalPublication: false,
        sessionId: "session-api",
      },
    ],
    [
      {
        ...makeBranchPrRowFixture(),
        repoFullName: "acme/web",
        branchName,
        prNumber: 10,
        mergedAt: null,
        linesAdded: null,
        linesRemoved: null,
      },
      {
        ...makeBranchPrRowFixture(),
        repoFullName: "acme/api",
        branchName,
        prNumber: 20,
        linesAdded: 100,
        linesRemoved: 20,
      },
    ]
  );

  assert.deepEqual(evidence.contributions, [
    {
      sourceEventId: "merged-pr:acme/api#20",
      changeIdentity: "acme/api#20",
      branchId: apiBranchId,
      occurredAt: "2026-08-01T00:00:00.000Z",
      additions: 100,
      deletions: 20,
      source: BranchPublicationLocSource.MergedPullRequest,
    },
  ]);
  assert.deepEqual(evidence.coverageGaps, [
    {
      sourceEventId: `${webBranchId}:merged-pr:10`,
      occurredAt: null,
    },
    {
      sourceEventId: `${webBranchId}:successful-push`,
      occurredAt: "2026-08-02T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(evidence.completeBranchIds, [apiBranchId]);
  assert.equal(evidence.coverageComplete, false);
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
  for (const [activityCapped, lifecycleCapped] of [
    [true, false],
    [false, true],
  ] as const) {
    const evidence = buildPhaseEvidence(
      { rows: [], capped: activityCapped },
      { rows: [], capped: lifecycleCapped }
    );

    assert.deepEqual(evidence.coverageReasons, [
      BranchPhaseAttributionCompletenessReason.CoverageCapped,
    ]);
  }

  assert.deepEqual(
    buildPhaseEvidence({ rows: [], capped: false }, { rows: [], capped: false })
      .coverageReasons,
    []
  );
});

test("desktop detail retains the compatibility selected-PR fallback without lifetime evidence", () => {
  const detail: Pick<
    BranchPageDetail,
    | "associatedPullRequests"
    | "phaseAttribution"
    | "canonicalMetrics"
    | "estimatedCostUsd"
    | "attributedCostUsd"
  > & { additions: number; deletions: number } = {
    additions: 1000,
    deletions: 1000,
    estimatedCostUsd: 20,
    attributedCostUsd: 20,
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
    ...makeBranchPrRowFixture(),
    branchName: "feature/active-branch",
    linesAdded: 50,
    linesRemoved: 50,
  };

  attachDesktopCanonicalDetailMetrics(detail, [selectedPr]);

  assert.equal(detail.canonicalMetrics?.locPerDollar.value, 5);
});

test("ISS-6949: desktop detail metrics use the branch's attributed cost", () => {
  // Same contract as the cloud attacher: the card total is the canonical
  // attributed cost, never the phase-rollup residue.
  const detail: Pick<
    BranchPageDetail,
    | "associatedPullRequests"
    | "phaseAttribution"
    | "canonicalMetrics"
    | "estimatedCostUsd"
    | "attributedCostUsd"
  > = {
    estimatedCostUsd: 48,
    attributedCostUsd: 24,
    associatedPullRequests: {
      items: [],
      selectedId: null,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Ambiguous,
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
          estimatedCostUsd: 8,
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
        subtotalUsd: 8,
      },
    },
  };

  attachDesktopCanonicalDetailMetrics(detail, []);

  assert.equal(detail.canonicalMetrics?.totalCostUsd.value, 24);
});

function publicationLink(branchName: string): BranchLinkRow {
  return {
    repoFullName: "acme/web",
    branchName,
    hasLocalPublication: true,
    successfulPushAt: "2026-08-02T00:00:00.000Z",
    sessionId: "session-1",
    sessionName: "work",
    isPrimary: true,
    observedAt: "2026-08-02T00:00:00.000Z",
    activityAt: "2026-08-02T00:00:00.000Z",
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    ownerUserId: null,
    priority: null,
  };
}

/** The window's spend as the SQL fold would hand it over for one priced event. */
function aiSpendFactsOf(costUsd: number | null) {
  return costFactsFromContributions(
    [
      {
        sourceEventId: "event-1",
        branchId: "feature/shared",
        sessionId: "session-1",
        occurredAt: usageEvent().createdAt,
        costUsd,
        qualifyingBranchCount: 1,
      },
    ],
    branchMetricFactWindows(
      resolveCanonicalBranchMetricWindows({
        startDate: "2026-07-27T00:00:00.000Z",
        endDate: "2026-08-03T00:00:00.000Z",
        now: new Date("2026-08-03T00:00:00.000Z"),
      })
    )
  );
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

function activitySegment(sessionId: string) {
  return {
    sessionId,
    phase: "implement",
    startMs: Date.parse("2026-08-01T00:00:00.000Z"),
    endMs: Date.parse("2026-08-01T00:01:00.000Z"),
    confidence: 1,
  };
}

function lifecycleEvent(
  branchName: string,
  repoFullName: string,
  sessionId: string,
  evidenceId: string
) {
  return {
    repoFullName,
    branchName,
    sessionId,
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    sessionEndedAt: "2026-08-01T00:01:00.000Z",
    kind: BranchLifecycleBoundaryKind.BranchWrite,
    observedAt: "2026-08-01T00:00:30.000Z",
    evidenceId,
    method: "git_push",
  };
}

function phaseEvidence(branchName = "feature/active-branch") {
  return {
    activitySegmentRows: [activitySegment("session-1")],
    lifecycleEventRows: [
      lifecycleEvent(branchName, "acme/web", "session-1", "push-1"),
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
