import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type BranchPageDetail,
  type BranchSelectedPullRequestDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-check-projection";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  type BranchDetailMetricBundle,
  BranchMetricAvailability,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { projectBranchSelectedPullRequestChecks } from "@repo/api/src/types/branch-selected-pull-request-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";

const SELECTED_PULL_REQUEST_ID = "owner/repo#1270";
const SELECTED_PULL_REQUEST_URL = "https://github.com/owner/repo/pull/1270";
const SELECTED_PULL_REQUEST_HEAD_SHA = "b".repeat(40);
const OUTCOME_START_MS = Date.parse("2026-06-17T10:00:00.000Z");
const HALF_HOUR_MS = 30 * 60 * 1000;

/** Complete selected-cycle metric fixture shared by isolated Branch stories. */
export function completeMetrics(): BranchDetailMetricBundle {
  return {
    locPerDollar: { state: BranchMetricAvailability.Complete, value: 42.5 },
    phaseCostUsd: {
      [BranchVisibleLifecyclePhase.Build]: {
        state: BranchMetricAvailability.Complete,
        value: 2,
      },
      [BranchVisibleLifecyclePhase.Review]: {
        state: BranchMetricAvailability.Complete,
        value: 1,
      },
      [BranchVisibleLifecyclePhase.Rework]: {
        state: BranchMetricAvailability.Complete,
        value: 1,
      },
    },
    totalCostUsd: { state: BranchMetricAvailability.Complete, value: 4 },
    leadTimeMs: {
      state: BranchMetricAvailability.Complete,
      value: 7_200_000,
    },
    abandonmentTimeMs: {
      state: BranchMetricAvailability.NotApplicable,
      value: null,
    },
    idleTimeMs: {
      state: BranchMetricAvailability.Complete,
      value: 1_800_000,
    },
  };
}

/** Complete selected-cycle phase evidence matching {@link completeMetrics}. */
export function completePhaseAttribution(): BranchPhaseAttributionResult {
  const segments = [
    phaseSegment(
      BranchVisibleLifecyclePhase.Build,
      OUTCOME_START_MS,
      OUTCOME_START_MS + HALF_HOUR_MS,
      2
    ),
    phaseSegment(
      BranchVisibleLifecyclePhase.Review,
      OUTCOME_START_MS + 2 * HALF_HOUR_MS,
      OUTCOME_START_MS + 3 * HALF_HOUR_MS,
      1
    ),
    phaseSegment(
      BranchVisibleLifecyclePhase.Rework,
      OUTCOME_START_MS + 3 * HALF_HOUR_MS,
      OUTCOME_START_MS + 4 * HALF_HOUR_MS,
      1
    ),
  ];

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
      subtotalUsd: 4,
    },
  };
}

/** Merged selected PR whose timestamps define the complete story outcome. */
export function completeSelectedPullRequest(): BranchSelectedPullRequestDetail {
  return {
    id: SELECTED_PULL_REQUEST_ID,
    repositoryFullName: "owner/repo",
    number: 1270,
    title: "Add Branch Detail page",
    url: SELECTED_PULL_REQUEST_URL,
    state: GitHubPRState.Merged,
    isDraft: false,
    reviewDecision: ReviewDecision.Approved,
    openedAt: "2026-06-17T11:00:00.000Z",
    closedAt: "2026-06-17T12:00:00.000Z",
    mergedAt: "2026-06-17T12:00:00.000Z",
    body: "Implements the Branch Detail shell.",
    headRefOid: SELECTED_PULL_REQUEST_HEAD_SHA,
    mergeCommitSha: "c".repeat(40),
    baseRefName: "main",
    authorLogin: "octocat",
    changedFiles: 3,
    additions: 180,
    deletions: 24,
  };
}

/**
 * Complete selected-head checks evidence for the populated Branch story. The
 * pull request is overridable so a multi-PR fixture gives each PR its own.
 */
export function completeSelectedPullRequestChecks(
  pullRequest: { headSha: string; number: number; url: string } = {
    headSha: SELECTED_PULL_REQUEST_HEAD_SHA,
    number: 1270,
    url: SELECTED_PULL_REQUEST_URL,
  }
) {
  return projectBranchSelectedPullRequestChecks({
    identity: {
      githubId: `PR_kwDO_story_${pullRequest.number}`,
      repositoryFullName: "owner/repo",
      number: pullRequest.number,
      url: pullRequest.url,
    },
    revision: { headSha: pullRequest.headSha },
    checks: [
      storyCheck("build", "Build", "success", pullRequest.url),
      storyCheck("test", "Test", "success", pullRequest.url),
      storyCheck("e2e", "End-to-end", "success", pullRequest.url),
    ],
    counts: {
      providerExpected: 3,
      providerReturned: 3,
      normalizedAttempts: 3,
      emitted: 3,
      total: 3,
      successful: 3,
      failing: 0,
      pending: 0,
      neutral: 0,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      acquisitionMaximum: 500,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: 3,
      emittedSources: 3,
    },
    coverage: {
      completeness: SelectedPullRequestChecksCompleteness.Complete,
      reasons: [],
    },
  });
}

/**
 * The populated Branch Detail fixture, shared by `branch-detail-page.stories.tsx`
 * and ISS-10963's design harness. A plain module so a non-Storybook consumer
 * does not compile CSF `Meta`/`StoryObj` types (that import hit TS2883).
 */
export function populatedDetail(): BranchPageDetail {
  const selectedPullRequest = completeSelectedPullRequest();
  return {
    id: "b-1",
    branchName: "feature/branches-detail",
    baseBranch: "main",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Merged,
    prNumber: 1270,
    prTitle: "Add Branch Detail page",
    prState: GitHubPRState.Merged,
    prUrl: "https://github.com/owner/repo/pull/1270",
    multiPrWarning: false,
    // ISS-8241: the Branch detail's checks scalars are the SELECTED PR's own
    // measured rollup, not a fold of the live evidence beside them -- and the
    // rollup and the projection below are written together by one helper, so a
    // fixture carrying one without the other is a state the API cannot produce.
    checksStatus: ChecksStatus.Passing,
    checksPassed: null,
    checksTotal: 3,
    selectedPullRequestChecksProjection: {
      headSha: selectedPullRequest.headRefOid ?? "b".repeat(40),
      providerState: BranchViewChecksProviderState.Available,
      unavailableReason: null,
      totalCount: 3,
      truncated: false,
      items: [
        {
          id: "build",
          kind: BranchViewCheckKind.CheckRun,
          name: "Build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          targetUrl: null,
        },
      ],
    },
    reviewDecision: selectedPullRequest.reviewDecision,
    ahead: null,
    behind: null,
    additions: 180,
    deletions: 24,
    filesChanged: 3,
    estimatedCostUsd: 4,
    lastActivityAt: "2026-06-17T12:00:00.000Z",
    sessionIds: ["s1"],
    prBody: "Implements the Branch Detail shell.",
    prBodyHtmlUrl: "https://github.com/owner/repo/pull/1270",
    headSha: selectedPullRequest.headRefOid,
    mergeCommitSha: selectedPullRequest.mergeCommitSha,
    mergedAt: "2026-06-17T12:00:00.000Z",
    closedAt: "2026-06-17T12:00:00.000Z",
    openedAt: selectedPullRequest.openedAt,
    commits: [],
    sessions: [
      {
        sessionId: "s1",
        slug: "sess-one",
        name: "Scaffold the shell",
        harness: "claude",
        startedAt: "2026-06-17T09:00:00.000Z",
        endedAt: "2026-06-17T10:00:00.000Z",
        isPrimary: true,
        estimatedCostUsd: 4,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 500,
        cacheWriteTokens: 300,
        ownerUserName: "Cosimo",
      },
    ],
    mergedTrace: [{ type: "end", sessionId: "s1", text: "Session ended" }],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [1270],
    linkedArtifacts: [{ slug: "FEA-1952" }, { slug: "PLN-988" }],
    associatedPullRequests: {
      items: [
        {
          id: "owner/repo#1270",
          repositoryFullName: "owner/repo",
          number: 1270,
          title: "Add Branch Detail page",
          url: "https://github.com/owner/repo/pull/1270",
          state: GitHubPRState.Merged,
          isDraft: false,
          reviewDecision: selectedPullRequest.reviewDecision,
          openedAt: selectedPullRequest.openedAt,
          closedAt: selectedPullRequest.closedAt,
          mergedAt: selectedPullRequest.mergedAt,
        },
      ],
      selectedId: "owner/repo#1270",
      selectionReason:
        BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    selectedPullRequest,
    selectedPullRequestChecks: completeSelectedPullRequestChecks(),
    phaseAttribution: completePhaseAttribution(),
    canonicalMetrics: completeMetrics(),
    // ISS-12197: the Artifact row's generic fields the cloud read serves, so
    // the Details tab's generic block renders in the Populated story.
    slug: "BR-1",
    assignee: {
      avatarUrl: null,
      email: "sam@example.com",
      firstName: "Sam",
      id: "user-sam",
      lastName: "Lee",
    },
    createdAt: "2026-06-17T08:55:00.000Z",
    createdBy: {
      avatarUrl: null,
      email: "alex@example.com",
      firstName: "Alex",
      id: "user-alex",
      lastName: "Rivera",
    },
    updatedAt: "2026-06-17T12:19:00.000Z",
    dueDate: "2026-06-24T00:00:00.000Z",
    projectName: "Branches",
    parent: {
      documentType: null,
      id: "artifact-fea-1952",
      name: "Branch detail page",
      slug: "FEA-1952",
      type: ArtifactType.Document,
    },
  };
}

function phaseSegment(
  phase: BranchVisibleLifecyclePhase,
  startMs: number,
  endMs: number,
  estimatedCostUsd: number
) {
  return {
    sessionId: `story-${phase}`,
    sequence: 0,
    phase,
    startMs,
    endMs,
    estimatedCostUsd,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    evidenceIds: [`story-${phase}-evidence`],
  };
}

function storyCheck(
  providerId: string,
  name: string,
  conclusion: string,
  pullRequestUrl: string
) {
  return {
    providerId,
    sourceIdentity: providerId,
    sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
    sourceApp: null,
    name,
    providerStatus: "completed",
    providerConclusion: conclusion,
    category: SelectedPullRequestCheckCategory.Successful,
    createdAt: "2026-06-17T11:00:00.000Z",
    startedAt: "2026-06-17T11:01:00.000Z",
    completedAt: "2026-06-17T11:05:00.000Z",
    targetUrl: `${pullRequestUrl}/checks`,
  };
}
