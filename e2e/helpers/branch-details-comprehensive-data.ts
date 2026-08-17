import {
  BranchDataState,
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { BranchProjectionEvidenceDelivery } from "@repo/api/src/types/branch-projection";
import { BranchSelectedPullRequestChecksSummary } from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  BranchSelectedPullRequestFileCompleteness,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestFilePartialReason,
} from "@repo/api/src/types/selected-pull-request-evidence";

export const BRANCH_ID = "branch-details-comprehensive-e2e";
export const BRANCH_NAME = "feature/comprehensive-branch-details";
export const REPOSITORY = "closedloop-ai/symphony-alpha";
export const ACTIVE_PR = 4473;
export const HISTORICAL_PR = 4388;
export const ACTIVE_DESCRIPTION = "Active pull request delivery evidence";
export const HISTORICAL_DESCRIPTION =
  "Historical pull request delivery evidence";
export const PR_BODY_AUTOMATION_MARKER =
  "ISS-4783-AUTOMATION-COMMENT-MUST-STAY-HIDDEN";
const ACTIVE_PR_BODY = `## ${ACTIVE_DESCRIPTION}

The active PR has **formatted delivery evidence**.

- [x] Shared web and Desktop rendering

| Surface | Status |
| --- | --- |
| Branch details | Ready |

<!-- ${PR_BODY_AUTOMATION_MARKER} -->`;
const HISTORICAL_PR_BODY = `## ${HISTORICAL_DESCRIPTION}

The historical PR keeps its **own selected description**.

<!-- ${PR_BODY_AUTOMATION_MARKER} -->`;
export const BRANCH_OWNER = "Ada Lovelace";
export const BASE_SHA = "a".repeat(40);
export const ACTIVE_HEAD_SHA = "b".repeat(40);
export const HISTORICAL_HEAD_SHA = "c".repeat(40);
export const ACTIVE_FILE_PATH = "active-only.ts";
export const HISTORICAL_FILE_PATH = "historical-only.ts";

export function detailFor(prNumber: number): BranchPageDetail {
  const historical = prNumber === HISTORICAL_PR;
  const variant = branchVariant(historical);
  const selected = associatedPullRequests().items.find(
    (item) => item.number === prNumber
  )!;
  return {
    additions: variant.additions,
    ahead: null,
    associatedPullRequests: associatedPullRequests(),
    baseBranch: "main",
    behind: null,
    branchName: BRANCH_NAME,
    checksPassed: variant.checksPassed,
    checksStatus: variant.checksStatus,
    checksTotal: variant.checksTotal,
    closedAt: selected.closedAt,
    commits: [
      {
        sha: "1234567",
        committedAt: "2026-08-01T10:20:00.000Z",
        message: "Wire branch details",
      },
    ],
    dataState: BranchDataState.Ready,
    deletions: variant.deletions,
    // Preserve the raw replicated compatibility total while the canonical
    // attributed total drives every Branches cost display.
    estimatedCostUsd: 48,
    attributedCostUsd: 24,
    filesChanged: variant.filesChanged,
    headSha: variant.headSha,
    id: BRANCH_ID,
    lastActivityAt: "2026-08-01T11:00:00.000Z",
    leadTime: variant.leadTime,
    linkedArtifacts: [
      { slug: "ISS-4473", label: "Comprehensive Branch details" },
    ],
    linkedPrNumbers: [ACTIVE_PR, HISTORICAL_PR],
    mergeCommitSha: variant.mergeCommitSha,
    mergedAt: selected.mergedAt,
    mergedTrace: [],
    multiPrWarning: false,
    openedAt: selected.openedAt,
    owner: BRANCH_OWNER,
    prBody: variant.description,
    prBodyHtmlUrl: selected.url,
    prNumber,
    prState: selected.state,
    prTitle: selected.title,
    prUrl: selected.url,
    repoFullName: REPOSITORY,
    reviewDecision: selected.reviewDecision,
    phaseAttribution: phaseAttributionFor(historical),
    selectedPullRequest: {
      ...selected,
      additions: variant.additions,
      body: variant.description,
      changedFiles: variant.filesChanged,
      deletions: variant.deletions,
      headRefOid: variant.headSha,
      mergeCommitSha: variant.mergeCommitSha,
    },
    selectedPullRequestChecks: checksFor(prNumber),
    sessionIds: ["session-build", "session-review", "session-rework"],
    sessions: sessions(),
    status: variant.status,
    canonicalMetrics: canonicalMetricsFor(historical),
    canonicalProjection: {
      version: "v1",
      common: {
        identity: {
          artifactId: BRANCH_ID,
          projectId: "project-4473",
          branchName: BRANCH_NAME,
          repositoryFullName: REPOSITORY,
        },
        membership: {
          sessionIds: ["session-build", "session-review", "session-rework"],
          qualifyingSessionCount: 3,
          sessions: [],
        },
        people: {
          owner: { availability: "complete", person: null },
          collaborators: {
            availability: "complete",
            people: [],
            sources: {
              pull_request_comments: "complete",
              branch_comments: "complete",
              session_comments: "complete",
            },
          },
        },
        tags: {
          items: [],
          availability: "available",
          permissions: { canApply: false, canRemove: false },
        },
        pullRequests: {
          associatedCount: 2,
          selected,
          selectionReason: variant.selectionReason,
          completeness: associatedPullRequests().completeness,
        },
        lastActiveAt: {
          state: BranchMetricAvailability.Complete,
          value: "2026-08-01T11:00:00.000Z",
        },
        evidence: {
          comments: { delivery: BranchProjectionEvidenceDelivery.Lazy },
          checks: { delivery: BranchProjectionEvidenceDelivery.Lazy },
          files: { delivery: BranchProjectionEvidenceDelivery.Lazy },
          trace: { delivery: BranchProjectionEvidenceDelivery.Lazy },
        },
        provenance: { source: "cloud" },
      },
      list: {
        status: variant.status,
        dataState: BranchDataState.Ready,
        selectedPullRequest: {
          id: selected.id,
          checksStatus: variant.checksStatus,
          checksPassed: variant.checksPassed,
          checksTotal: variant.checksTotal,
        },
        changes: {
          additions: variant.additions,
          deletions: variant.deletions,
          filesChanged: variant.filesChanged,
        },
        cost: { replicatedUsd: 48, attributedUsd: 24 },
      },
      detail: {},
    },
  };
}

/** Complete collection with zero artifacts while selected PR evidence remains. */
export function completeEmptyLinkedArtifactsDetailFor(
  prNumber: number
): BranchPageDetail {
  return withCompleteEmptyLinkedArtifacts(detailFor(prNumber));
}

/** Unavailable collection with zero artifacts while selected PR evidence remains. */
export function unavailableEmptyLinkedArtifactsDetailFor(
  prNumber: number
): BranchPageDetail {
  return withUnavailableEmptyLinkedArtifacts(detailFor(prNumber));
}

/** Projects complete-empty linked-artifact evidence without changing PR data. */
export function withCompleteEmptyLinkedArtifacts(
  detail: BranchPageDetail
): BranchPageDetail {
  return {
    ...detail,
    linkedArtifacts: [],
    linkedArtifactsCollection: {
      state: BranchLinkedArtifactCollectionState.Complete,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    },
  };
}

/** Projects unavailable empty linked-artifact evidence without changing PR data. */
export function withUnavailableEmptyLinkedArtifacts(
  detail: BranchPageDetail
): BranchPageDetail {
  return {
    ...detail,
    linkedArtifacts: [],
    linkedArtifactsCollection: {
      state: BranchLinkedArtifactCollectionState.Unavailable,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    },
  };
}

/** Loaded-detail fixture with one priced Session whose timing cannot form a bar. */
export function timingIncompleteDetailFor(prNumber: number): BranchPageDetail {
  const detail = detailFor(prNumber);
  return {
    ...detail,
    sessions: detail.sessions.map((session) =>
      session.sessionId === "session-rework"
        ? { ...session, endedAt: session.startedAt }
        : session
    ),
  };
}

function associatedPullRequests() {
  const items = [
    {
      id: `${REPOSITORY}#${ACTIVE_PR}`,
      repositoryFullName: REPOSITORY,
      number: ACTIVE_PR,
      title: "Comprehensive Branch details",
      url: `https://github.com/${REPOSITORY}/pull/${ACTIVE_PR}`,
      state: GitHubPRState.Open,
      isDraft: false,
      reviewDecision: ReviewDecision.Approved,
      openedAt: "2026-08-01T10:00:00.000Z",
      closedAt: null,
      mergedAt: null,
    },
    {
      id: `${REPOSITORY}#${HISTORICAL_PR}`,
      repositoryFullName: REPOSITORY,
      number: HISTORICAL_PR,
      title: "Historical implementation",
      url: `https://github.com/${REPOSITORY}/pull/${HISTORICAL_PR}`,
      state: GitHubPRState.Merged,
      isDraft: false,
      reviewDecision: ReviewDecision.ChangesRequested,
      openedAt: "2026-07-30T09:00:00.000Z",
      closedAt: "2026-08-03T05:40:01.000Z",
      mergedAt: "2026-08-03T05:40:01.000Z",
    },
  ] as const;
  return {
    items,
    selectedId: items[0].id,
    selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
    },
  } as const;
}

export function checksFor(prNumber: number) {
  const historical = prNumber === HISTORICAL_PR;
  const emitted = historical ? 2 : 4;
  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value: {
      identity: {
        githubId: `PR_${prNumber}`,
        repositoryFullName: REPOSITORY,
        number: prNumber,
        url: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
      },
      revision: { headSha: historical ? HISTORICAL_HEAD_SHA : ACTIVE_HEAD_SHA },
      checks: [
        {
          providerId: `check-${prNumber}`,
          sourceIdentity: `check-${prNumber}`,
          sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
          sourceApp: null,
          name: historical ? "Historical unit checks" : "Active unit checks",
          providerStatus: "COMPLETED",
          providerConclusion: historical ? "FAILURE" : "SUCCESS",
          category: historical
            ? SelectedPullRequestCheckCategory.Failing
            : SelectedPullRequestCheckCategory.Successful,
          createdAt: null,
          startedAt: null,
          completedAt: null,
          targetUrl: null,
        },
      ],
      counts: {
        providerExpected: historical ? 5 : 4,
        providerReturned: emitted,
        normalizedAttempts: emitted,
        emitted,
        total: emitted,
        successful: historical ? 1 : 4,
        failing: historical ? 1 : 0,
        pending: 0,
        neutral: 0,
      },
      pagination: {
        pageSize: 100,
        pagesFetched: 1,
        acquisitionMaximum: 3000,
        reachedAcquisitionMaximum: false,
      },
      history: {
        mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
        providerLimit: null,
        rawAttempts: emitted,
        emittedSources: emitted,
      },
      coverage: {
        completeness: historical
          ? SelectedPullRequestChecksCompleteness.Partial
          : SelectedPullRequestChecksCompleteness.Complete,
        reasons: historical
          ? [SelectedPullRequestChecksPartialReason.CountMismatch]
          : [],
      },
      summary: historical
        ? BranchSelectedPullRequestChecksSummary.Partial
        : BranchSelectedPullRequestChecksSummary.Successful,
    },
  } as const;
}

export function filesFor(
  prNumber: number
): BranchSelectedPullRequestFilesResponse {
  const historical = prNumber === HISTORICAL_PR;
  const loaded = 1;
  const expected = branchVariant(historical).filesChanged;
  return {
    status: BranchSelectedPullRequestReadAvailability.Available,
    value: {
      identity: {
        githubId: `PR_${prNumber}`,
        repositoryFullName: REPOSITORY,
        number: prNumber,
        url: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
      },
      revision: {
        baseSha: BASE_SHA,
        headSha: historical ? HISTORICAL_HEAD_SHA : ACTIVE_HEAD_SHA,
      },
      files: [
        {
          path: historical ? HISTORICAL_FILE_PATH : ACTIVE_FILE_PATH,
          providerStatus: "modified",
          status: "modified",
          additions: historical ? 8 : 80,
          deletions: historical ? 2 : 20,
          changes: historical ? 10 : 100,
        },
      ],
      counts: {
        expected,
        loaded,
        providerExpected: expected,
        providerReturned: loaded,
      },
      coverage: historical
        ? {
            completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
            reasons: [SelectedPullRequestFilePartialReason.CountMismatch],
          }
        : {
            completeness: BranchSelectedPullRequestFileCompleteness.Complete,
            reasons: [],
          },
      grossTotals: {
        additions: {
          availability:
            BranchSelectedPullRequestGrossTotalAvailability.Available,
          value: historical ? 8 : 80,
          completeness: historical
            ? BranchSelectedPullRequestFileCompleteness.Incomplete
            : BranchSelectedPullRequestFileCompleteness.Complete,
        },
        deletions: {
          availability:
            BranchSelectedPullRequestGrossTotalAvailability.Available,
          value: historical ? 2 : 20,
          completeness: historical
            ? BranchSelectedPullRequestFileCompleteness.Incomplete
            : BranchSelectedPullRequestFileCompleteness.Complete,
        },
      },
      pagination: {
        pageSize: 100,
        pagesFetched: 1,
        providerMaximum: 3000,
        reachedProviderMaximum: false,
      },
    },
  };
}
function sessions(): BranchPageDetail["sessions"] {
  return ["build", "review", "rework"].map((phase, index) => ({
    sessionId: `session-${phase}`,
    slug: `session-${phase}`,
    name: `${phase[0]!.toUpperCase()}${phase.slice(1)} session`,
    harness: "codex",
    startedAt: `2026-07-30T09:${index}0:00.000Z`,
    endedAt: `2026-07-30T09:${index}5:00.000Z`,
    isPrimary: index === 0,
    estimatedCostUsd: 8,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ownerUserName: index === 0 ? "Ada Lovelace" : "Grace Hopper",
  }));
}

function branchVariant(historical: boolean) {
  if (historical) {
    return {
      additions: 30,
      checksPassed: 1,
      checksStatus: ChecksStatus.Failing,
      checksTotal: 5,
      deletions: 10,
      description: HISTORICAL_PR_BODY,
      filesChanged: 3,
      headSha: HISTORICAL_HEAD_SHA,
      leadTime: leadTimeActivity(true),
      mergeCommitSha: "d".repeat(40),
      selectionReason: BranchAssociatedPullRequestSelectionReason.Explicit,
      status: BranchStatus.Merged,
    };
  }
  return {
    additions: 120,
    checksPassed: 4,
    checksStatus: ChecksStatus.Passing,
    checksTotal: 4,
    deletions: 40,
    description: ACTIVE_PR_BODY,
    filesChanged: 1,
    headSha: ACTIVE_HEAD_SHA,
    leadTime: leadTimeActivity(false),
    mergeCommitSha: null,
    selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
    status: BranchStatus.Open,
  };
}

function canonicalMetricsFor(
  historical: boolean
): NonNullable<BranchPageDetail["canonicalMetrics"]> {
  const notApplicable = {
    state: BranchMetricAvailability.NotApplicable,
    value: null,
  } as const;
  return {
    locPerDollar: completeMetric(historical ? 1.67 : 6.67),
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: completeMetric(8),
      [BranchVisibleLifecyclePhase.Review]: completeMetric(8),
      [BranchVisibleLifecyclePhase.Rework]: completeMetric(8),
    },
    totalCostUsd: completeMetric(24),
    leadTimeMs: historical ? completeMetric(333_601_000) : notApplicable,
    abandonmentTimeMs: notApplicable,
    idleTimeMs: completeMetric(1_200_000),
  };
}

function phaseAttributionFor(
  historical: boolean
): NonNullable<BranchPageDetail["phaseAttribution"]> {
  const cycleStart = Date.parse(
    historical ? "2026-07-30T09:00:00.000Z" : "2026-08-01T09:00:00.000Z"
  );
  const phases = [
    BranchVisibleLifecyclePhase.Build,
    BranchVisibleLifecyclePhase.Review,
    BranchVisibleLifecyclePhase.Rework,
  ] as const;
  const durations = historical
    ? [172_800_000, 86_400_000, 73_201_000]
    : [3_600_000, 3_600_000, 1_800_000];
  let cursor = cycleStart;
  const segments = phases.map((phase, index) => {
    const startMs = cursor;
    const endMs = startMs + (durations[index] ?? 0);
    cursor =
      historical && phase === BranchVisibleLifecyclePhase.Build
        ? endMs + 1_200_000
        : endMs;
    return {
      sessionId: `session-${phase}`,
      sequence: index,
      phase,
      startMs,
      endMs,
      estimatedCostUsd: 8,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      evidenceIds: [`event-${phase}`],
      qualifyingBranchCount: 1,
      costEvents: [
        {
          sourceEventId: `event-${phase}`,
          occurredAtMs: startMs,
          costUsd: 8,
        },
      ],
    };
  });
  return {
    segments,
    rollups: segments.map((segment) => ({
      phase: segment.phase,
      estimatedCostUsd: segment.estimatedCostUsd,
      inputTokens: segment.inputTokens,
      outputTokens: segment.outputTokens,
      cacheReadTokens: segment.cacheReadTokens,
      cacheWriteTokens: segment.cacheWriteTokens,
      durationMs: segment.endMs - segment.startMs,
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 24,
    },
  };
}

function completeMetric(value: number) {
  return { state: BranchMetricAvailability.Complete, value } as const;
}

function leadTimeActivity(historical: boolean): BranchPageDetail["leadTime"] {
  if (historical) {
    return {
      firstActivityT: "2026-07-30T09:00:00.000Z",
      idleSpans: [
        {
          startT: "2026-08-01T09:00:00.000Z",
          endT: "2026-08-01T09:20:00.000Z",
          gapMs: 1_200_000,
        },
      ],
      lastActivityT: "2026-08-03T05:40:01.000Z",
    };
  }
  return {
    firstActivityT: "2026-07-30T09:00:00.000Z",
    idleSpans: [
      {
        startT: "2026-07-30T09:20:00.000Z",
        endT: "2026-07-30T09:40:00.000Z",
        gapMs: 1_200_000,
      },
    ],
    lastActivityT: "2026-07-30T11:00:00.000Z",
  };
}
