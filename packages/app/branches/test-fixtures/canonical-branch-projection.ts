import {
  BranchCommentsBudget,
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchDataState,
  type BranchListResponse,
  type BranchPageDetail,
  BranchStatus,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import {
  BranchProjectionEvidenceDelivery,
  BranchProjectionVersion,
  type CanonicalBranchProjectionV1,
} from "@repo/api/src/types/branch-projection";
import {
  BranchSelectedPullRequestFileCompleteness,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { ReadSource } from "@repo/api/src/types/read-source";
import {
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { TagColor } from "@repo/api/src/types/tag";

const observedAt = "2026-07-31T12:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

/**
 * Complete canonical projection fixture shared by web-adapter and Desktop IPC
 * tests. It deliberately combines repository-qualified PR identity, partial
 * Session hydration, incomplete cost/metrics, permissions, and typed evidence
 * failures so a transport mapper cannot silently discard difficult fields.
 */
export const canonicalBranchProjectionFixture: CanonicalBranchProjectionV1 = {
  version: BranchProjectionVersion.V1,
  common: {
    identity: {
      artifactId: "branch-artifact-1",
      projectId: "project-1",
      branchName: "feature/canonical-parity",
      repositoryFullName: "closedloop-ai/symphony-alpha",
    },
    membership: {
      sessionIds: ["session-loaded", "session-unavailable"],
      qualifyingSessionCount: 2,
      sessions: [
        {
          artifactId: "session-loaded",
          name: "Build canonical projection",
          slug: "session-loaded",
          navigableRef: "session-loaded",
          externalSessionId: "external-loaded",
        },
        {
          artifactId: "session-unavailable",
          name: null,
          slug: null,
          navigableRef: "session-unavailable",
        },
      ],
    },
    people: {
      owner: {
        availability: BranchIdentityAvailability.Complete,
        person: {
          provider: BranchPersonProvider.GitHub,
          id: "github-user-1",
          userId: "user-1",
          login: "octocat",
          displayName: "Octo Cat",
          avatarUrl: "https://avatars.example/octocat",
          profileUrl: "https://github.com/octocat",
          actorType: GitHubActorType.User,
        },
      },
      collaborators: {
        availability: BranchIdentityAvailability.Incomplete,
        people: [
          {
            provider: BranchPersonProvider.ClosedLoop,
            id: "user-2",
            userId: "user-2",
            displayName: "Reviewer",
          },
        ],
        sources: {
          [BranchCollaboratorSource.PullRequestComments]:
            BranchIdentityAvailability.Complete,
          [BranchCollaboratorSource.BranchComments]:
            BranchIdentityAvailability.Incomplete,
          [BranchCollaboratorSource.SessionComments]:
            BranchIdentityAvailability.Unavailable,
        },
      },
    },
    tags: {
      items: [{ id: "tag-1", name: "needs-review", color: TagColor.Amber }],
      availability: BranchTagAvailability.Available,
      permissions: { canApply: true, canRemove: false },
    },
    pullRequests: {
      associatedCount: 2,
      selected: {
        id: "closedloop-ai/symphony-alpha#4406",
        repositoryFullName: "closedloop-ai/symphony-alpha",
        number: 4406,
        title: "Land canonical Branch projection",
        url: "https://github.com/closedloop-ai/symphony-alpha/pull/4406",
        state: GitHubPRState.Merged,
        isDraft: false,
        reviewDecision: ReviewDecision.Approved,
        openedAt: "2026-07-30T10:00:00.000Z",
        closedAt: observedAt,
        mergedAt: observedAt,
      },
      selectionReason:
        BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Incomplete,
        reasons: [
          BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate,
        ],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    lastActiveAt: {
      state: BranchMetricAvailability.Partial,
      value: observedAt,
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    },
    evidence: {
      comments: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          branchId: "branch-artifact-1",
          state: BranchCommentsState.ProviderError,
          failureReason: BranchCommentsFailureReason.ProviderUnavailable,
          budget: {
            maxComments: BranchCommentsBudget.MaxComments,
            pageSize: BranchCommentsBudget.PageSize,
            maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
            maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
            providerTruncated: false,
            responseTruncated: false,
            omittedComments: 0,
            bodyTruncatedCount: 0,
          },
          providerProofedAt: null,
          stale: true,
          mixedProjection: false,
          prNumber: 4406,
          prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/4406",
        },
      },
      checks: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          status: SelectedPullRequestEvidenceAvailability.Unavailable,
          reason:
            SelectedPullRequestEvidenceUnavailableReason.CredentialInsufficientScope,
          retryAfterSeconds: null,
        },
      },
      files: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          status: BranchSelectedPullRequestReadAvailability.Unavailable,
          source: BranchSelectedPullRequestUnavailableSource.Evidence,
          reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
          retryAfterSeconds: 30,
        },
      },
      trace: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          sessions: [
            {
              identity: {
                artifactId: "session-loaded",
                name: "Build canonical projection",
                slug: "session-loaded",
                navigableRef: "session-loaded",
              },
              state: BranchTraceSessionHydrationState.Loaded,
            },
            {
              identity: {
                artifactId: "session-unavailable",
                name: null,
                slug: null,
                navigableRef: "session-unavailable",
              },
              state: BranchTraceSessionHydrationState.Unavailable,
              reason: BranchTraceUnavailableReason.Permission,
            },
          ],
          qualifyingSessionCount: 2,
          completeness: {
            state: BranchTraceCompletenessState.Incomplete,
            reason: BranchTraceUnavailableReason.Permission,
          },
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Unavailable,
            reason: BranchTraceUnavailableReason.Permission,
          },
        },
      },
    },
    provenance: { source: ReadSource.Cloud },
  },
  list: {
    status: BranchStatus.Merged,
    dataState: BranchDataState.Ready,
    selectedPullRequest: {
      id: "closedloop-ai/symphony-alpha#4406",
      checksStatus: ChecksStatus.Unknown,
      checksPassed: null,
      checksTotal: null,
    },
    changes: { additions: 120, deletions: 40, filesChanged: 7 },
    cost: { replicatedUsd: 12, attributedUsd: 6 },
  },
  detail: {
    phaseAttribution: {
      segments: [
        {
          sessionId: "session-loaded",
          sequence: 0,
          phase: BranchVisibleLifecyclePhase.Build,
          startMs: 1000,
          endMs: 2000,
          estimatedCostUsd: 6,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          evidenceIds: ["event-1"],
          qualifyingBranchCount: 2,
          costEvents: [
            { sourceEventId: "event-1", occurredAtMs: 1500, costUsd: 6 },
          ],
        },
      ],
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 6,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          durationMs: 1000,
          sessionCount: 1,
        },
      ],
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Partial,
        reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
        subtotalUsd: 6,
      },
    },
    metrics: {
      locPerDollar: partialMetric(26.67),
      phaseCostUsd: {
        [BranchVisibleLifecyclePhase.Build]: partialMetric(6),
        [BranchVisibleLifecyclePhase.Review]: unavailableMetric(),
        [BranchVisibleLifecyclePhase.Rework]: unavailableMetric(),
      },
      totalCostUsd: partialMetric(6),
      leadTimeMs: completeMetric(86_400_000),
      abandonmentTimeMs: unavailableMetric(),
      idleTimeMs: partialMetric(3_600_000),
    },
    lifecyclePhaseStacks: [
      {
        phase: BranchVisibleLifecyclePhase.Build,
        estimatedCostUsd: 6,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        sessionCount: 1,
      },
    ],
  },
};

/** List response used identically by shared/web and authenticated Desktop tests. */
export const canonicalBranchListResponseFixture: BranchListResponse = {
  items: [
    {
      id: "branch-artifact-1",
      artifactId: "branch-artifact-1",
      projectId: "project-1",
      tags: [{ id: "tag-1", name: "needs-review", color: TagColor.Amber }],
      tagAvailability: BranchTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: false },
      branchName: "feature/canonical-parity",
      baseBranch: "main",
      repoFullName: "closedloop-ai/symphony-alpha",
      owner: "octocat",
      status: BranchStatus.Merged,
      prNumber: 4406,
      prTitle: "Land canonical Branch projection",
      prState: GitHubPRState.Merged,
      prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/4406",
      multiPrWarning: true,
      checksStatus: ChecksStatus.Unknown,
      checksPassed: null,
      checksTotal: null,
      reviewDecision: ReviewDecision.Approved,
      ahead: null,
      behind: null,
      additions: 120,
      deletions: 40,
      filesChanged: 7,
      estimatedCostUsd: 12,
      attributedCostUsd: 6,
      lastActivityAt: observedAt,
      sessionIds: ["session-loaded", "session-unavailable"],
      dataState: BranchDataState.Ready,
      canonicalProjection: canonicalBranchProjectionFixture,
    },
  ],
  total: 1,
  viewerScope: BranchViewerScope.Organization,
  hasMore: false,
  readSource: ReadSource.Cloud,
};

/** Immutable selected-PR revision shared by focused evidence variants. */
export const canonicalPullRequestRevisionFixture = { baseSha, headSha };

/** Alternate valid union branches that cannot coexist in the complete base. */
export const canonicalBranchProjectionVariants = [
  {
    ...canonicalBranchProjectionFixture,
    common: {
      ...canonicalBranchProjectionFixture.common,
      people: {
        owner: {
          availability: BranchIdentityAvailability.Unavailable,
          person: null,
        },
        collaborators: {
          availability: BranchIdentityAvailability.Unavailable,
          people: [],
          sources: {
            [BranchCollaboratorSource.PullRequestComments]:
              BranchIdentityAvailability.Unavailable,
            [BranchCollaboratorSource.BranchComments]:
              BranchIdentityAvailability.Unavailable,
            [BranchCollaboratorSource.SessionComments]:
              BranchIdentityAvailability.Unavailable,
          },
        },
      },
      tags: {
        availability: BranchTagAvailability.Unavailable,
      },
      pullRequests: {
        associatedCount: 0,
        selected: null,
        selectionReason: BranchAssociatedPullRequestSelectionReason.None,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
          reasons: [],
          provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
        },
      },
      evidence: {
        ...canonicalBranchProjectionFixture.common.evidence,
        comments: { delivery: BranchProjectionEvidenceDelivery.Lazy },
        checks: {
          delivery: BranchProjectionEvidenceDelivery.Lazy,
          summary: availableChecksSummary(),
        },
        files: {
          delivery: BranchProjectionEvidenceDelivery.Lazy,
          summary: availableFilesSummary(),
        },
        trace: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      },
    },
    list: {
      ...canonicalBranchProjectionFixture.list,
      selectedPullRequest: {
        id: null,
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
      },
    },
    detail: {},
  },
] satisfies readonly CanonicalBranchProjectionV1[];

/** Detail response used to pin the generic `/branches/:id` transport path. */
export const canonicalBranchDetailResponseFixture: BranchPageDetail = {
  ...canonicalBranchListResponseFixture.items[0]!,
  prBody: null,
  prBodyHtmlUrl: null,
  headSha,
  mergeCommitSha: null,
  mergedAt: observedAt,
  closedAt: observedAt,
  openedAt: "2026-07-30T10:00:00.000Z",
  commits: [],
  sessions: [],
  mergedTrace: [],
  leadTime: {
    firstActivityT: "2026-07-30T10:00:00.000Z",
    lastActivityT: observedAt,
    idleSpans: [],
  },
  linkedPrNumbers: [4406],
  linkedArtifacts: [],
};

function partialMetric(value: number) {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    coverage: { included: 1, total: 2 },
    disclosure: BranchMetricDisclosure.CostIncomplete,
  } as const;
}

function completeMetric(value: number) {
  return { state: BranchMetricAvailability.Complete, value } as const;
}

function unavailableMetric() {
  return {
    state: BranchMetricAvailability.Unavailable,
    value: null,
  } as const;
}

function availableFilesSummary() {
  return {
    status: BranchSelectedPullRequestReadAvailability.Available,
    value: {
      identity: selectedPullRequestIdentity(),
      revision: canonicalPullRequestRevisionFixture,
      counts: {
        expected: 0,
        loaded: 0,
        providerExpected: 0,
        providerReturned: 0,
      },
      coverage: {
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
        reasons: [],
      },
      grossTotals: {
        additions: {
          availability:
            BranchSelectedPullRequestGrossTotalAvailability.Available,
          value: 0,
          completeness: BranchSelectedPullRequestFileCompleteness.Complete,
        },
        deletions: {
          availability:
            BranchSelectedPullRequestGrossTotalAvailability.Available,
          value: 0,
          completeness: BranchSelectedPullRequestFileCompleteness.Complete,
        },
      },
      pagination: {
        pageSize: 100,
        pagesFetched: 1,
        providerMaximum: 3000,
        reachedProviderMaximum: false,
      },
    },
  } as const;
}

function availableChecksSummary() {
  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value: {
      identity: selectedPullRequestIdentity(),
      revision: { headSha },
      counts: {
        providerExpected: 0,
        providerReturned: 0,
        normalizedAttempts: 0,
        emitted: 0,
        total: 0,
        successful: 0,
        failing: 0,
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
        rawAttempts: 0,
        emittedSources: 0,
      },
      coverage: {
        completeness: SelectedPullRequestChecksCompleteness.Complete,
        reasons: [],
      },
    },
  } as const;
}

function selectedPullRequestIdentity() {
  return {
    githubId: "PR_kwDOcanonical",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    number: 4406,
    url: "https://github.com/closedloop-ai/symphony-alpha/pull/4406",
  } as const;
}
