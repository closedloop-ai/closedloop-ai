import type { BranchSelectedPullRequestDetail } from "@repo/api/src/types/branch";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
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
    changedFiles: 3,
    additions: 180,
    deletions: 24,
  };
}

/** Complete selected-head checks evidence for the populated Branch story. */
export function completeSelectedPullRequestChecks() {
  return projectBranchSelectedPullRequestChecks({
    identity: {
      githubId: "PR_kwDO_story_1270",
      repositoryFullName: "owner/repo",
      number: 1270,
      url: SELECTED_PULL_REQUEST_URL,
    },
    revision: { headSha: SELECTED_PULL_REQUEST_HEAD_SHA },
    checks: [
      storyCheck("build", "Build", "success"),
      storyCheck("test", "Test", "success"),
      storyCheck("e2e", "End-to-end", "success"),
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

function storyCheck(providerId: string, name: string, conclusion: string) {
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
    targetUrl: `${SELECTED_PULL_REQUEST_URL}/checks`,
  };
}
