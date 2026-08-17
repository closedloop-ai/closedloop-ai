import { describe, expect, it } from "vitest";
import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  BranchDataState,
  BranchStatus,
  BranchTagAvailability,
} from "./branch.ts";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "./branch-associated-pull-request.ts";
import { ChecksStatus } from "./branch-checks.ts";
import { BranchMetricAvailability } from "./branch-metrics.ts";
import {
  type BranchProjectionCommentsSummary,
  BranchProjectionEvidenceDelivery,
  type BranchProjectionEvidenceSummary,
  BranchProjectionVersion,
  type CanonicalBranchProjectionV1,
  isSupportedBranchProjectionVersion,
} from "./branch-projection.ts";
import {
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "./branch-selected-pull-request-files.ts";
import { BranchTraceCompletenessState } from "./branch-trace.ts";
import { ReadSource } from "./read-source.ts";
import {
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
} from "./selected-pull-request-checks-evidence.ts";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "./selected-pull-request-evidence.ts";

describe("canonical Branch projection contract", () => {
  it("accepts V1 and rejects absent or unknown projection generations", () => {
    expect(
      isSupportedBranchProjectionVersion({
        version: BranchProjectionVersion.V1,
      })
    ).toBe(true);
    expect(isSupportedBranchProjectionVersion({ version: "v2" })).toBe(false);
    expect(isSupportedBranchProjectionVersion({})).toBe(false);
    expect(isSupportedBranchProjectionVersion(undefined)).toBe(false);
  });

  it("represents unavailable optional data without fabricating payload rows", () => {
    const projection = makeProjection();

    expect(projection.common.tags).toEqual({
      availability: BranchTagAvailability.Unavailable,
    });
    expect(projection.common.evidence).toEqual(lazyEvidence());
    expect(projection.common.membership.sessions).toBeUndefined();
    expect(projection.detail).toBeUndefined();
  });

  it("preserves loaded owner states without carrying heavy evidence rows", () => {
    const evidence: BranchProjectionEvidenceSummary = {
      ...lazyEvidence(),
      checks: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          status: SelectedPullRequestEvidenceAvailability.Available,
          value: {
            identity: pullRequestIdentity(),
            revision: { headSha: "a".repeat(40) },
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
              acquisitionMaximum: 1000,
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
        },
      },
      files: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          status: BranchSelectedPullRequestReadAvailability.Unavailable,
          source: BranchSelectedPullRequestUnavailableSource.Evidence,
          reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
        },
      },
      comments: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: commentSummary(BranchCommentsState.OverLimitTruncated),
      },
      trace: {
        delivery: BranchProjectionEvidenceDelivery.Lazy,
        summary: {
          sessions: [],
          qualifyingSessionCount: 1,
          completeness: { state: BranchTraceCompletenessState.Incomplete },
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Unavailable,
          },
        },
      },
    };

    expect(evidence.checks.summary).not.toHaveProperty("value.checks");
    expect(evidence.files.summary).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
    });
    expect(evidence.comments.summary).toMatchObject({
      state: BranchCommentsState.OverLimitTruncated,
      stale: true,
    });
    expect(evidence.trace.summary).toMatchObject({
      qualifyingSessionCount: 1,
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Unavailable,
      },
    });
  });

  it.each([
    BranchCommentsState.SyncedEmpty,
    BranchCommentsState.StaleMixed,
    BranchCommentsState.ProviderError,
    BranchCommentsState.OverLimitTruncated,
  ])("retains the %s comments availability state", (state) => {
    expect(commentSummary(state).state).toBe(state);
  });
});

function makeProjection(): CanonicalBranchProjectionV1 {
  return {
    version: BranchProjectionVersion.V1,
    common: {
      identity: {
        artifactId: "branch-artifact-1",
        projectId: null,
        branchName: "feat/canonical-branch",
        repositoryFullName: "closedloop-ai/symphony-alpha",
      },
      membership: {
        sessionIds: [],
        qualifyingSessionCount: 0,
      },
      people: {},
      tags: { availability: BranchTagAvailability.Unavailable },
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
      lastActiveAt: {
        state: BranchMetricAvailability.NoData,
        value: null,
      },
      evidence: lazyEvidence(),
      provenance: { source: ReadSource.Cloud },
    },
    list: {
      status: BranchStatus.Open,
      dataState: BranchDataState.NoSessions,
      selectedPullRequest: {
        id: null,
        checksStatus: ChecksStatus.Unknown,
        checksPassed: null,
        checksTotal: null,
      },
      changes: { additions: null, deletions: null, filesChanged: null },
      cost: { replicatedUsd: null },
    },
  };
}

function lazyEvidence(): BranchProjectionEvidenceSummary {
  return {
    comments: { delivery: BranchProjectionEvidenceDelivery.Lazy },
    checks: { delivery: BranchProjectionEvidenceDelivery.Lazy },
    files: { delivery: BranchProjectionEvidenceDelivery.Lazy },
    trace: { delivery: BranchProjectionEvidenceDelivery.Lazy },
  };
}

function pullRequestIdentity() {
  return {
    githubId: "PR_kwDOExample",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    number: 7,
    url: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
  };
}

function commentSummary(
  state: BranchCommentsState
): BranchProjectionCommentsSummary {
  return {
    branchId: "branch-artifact-1",
    state,
    ...(state === BranchCommentsState.ProviderError
      ? { failureReason: BranchCommentsFailureReason.ProviderError }
      : {}),
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16 * 1024,
      maxResponseBytes: 512 * 1024,
      providerTruncated: false,
      responseTruncated: state === BranchCommentsState.OverLimitTruncated,
      omittedComments: state === BranchCommentsState.OverLimitTruncated ? 1 : 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale:
      state === BranchCommentsState.StaleMixed ||
      state === BranchCommentsState.OverLimitTruncated,
    mixedProjection: state === BranchCommentsState.StaleMixed,
    prNumber: 7,
    prUrl: pullRequestIdentity().url,
  };
}
