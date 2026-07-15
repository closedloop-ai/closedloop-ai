import {
  type BranchPageDetail,
  type BranchSession,
  BranchStatus,
  type BranchUsageActorBucket,
  type BranchUsageHourBucket,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";

/**
 * Shared Branch detail/session test fixtures — the single source for both the
 * panel suite (`components/__tests__`) and the derivation suite (`lib/__tests__`)
 * so the two can't drift. Contract enums use their canonical value
 * (`BranchStatus.Open`), never a raw string. Override any field via `over`.
 */
export function makeBranchSession(
  over: Partial<BranchSession> = {}
): BranchSession {
  return {
    sessionId: "s1",
    slug: null,
    name: null,
    harness: "claude",
    startedAt: "2026-06-10T10:00:00.000Z",
    endedAt: null,
    isPrimary: true,
    estimatedCostUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

export function makeBranchDetail(
  over: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  return {
    id: "b1",
    branchName: "feature/x",
    baseBranch: null,
    repoFullName: "acme/web",
    owner: null,
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-10T12:00:00.000Z",
    sessionIds: ["s1"],
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [],
    linkedArtifacts: [],
    ...over,
  };
}

export function makeUsageActorBucket(
  over: Partial<BranchUsageActorBucket> = {}
): BranchUsageActorBucket {
  return {
    owner: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    ...over,
  };
}

export function makeUsageHourBucket(
  over: Partial<BranchUsageHourBucket> = {}
): BranchUsageHourBucket {
  return {
    hourStart: "2026-06-10T10:00:00.000Z",
    byActor: [],
    ...over,
  };
}

export function makeBranchUsage(
  over: Partial<BranchUsageSummary> = {}
): BranchUsageSummary {
  return {
    viewerScope: BranchViewerScope.Self,
    totalBranches: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 0,
    hourBuckets: [],
    phaseStacks: [],
    byActor: [],
    ...over,
  };
}
