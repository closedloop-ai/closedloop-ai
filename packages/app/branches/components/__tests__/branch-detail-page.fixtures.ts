// Pure fixture/data-factory builders for the BranchDetailPage suite, split out
// of `branch-detail-page.test.tsx` to keep the spec file under the 1,000-line
// ceiling (AGENTS.md). These have no DOM/RTL dependency — they only shape the
// domain payloads the specs feed into the component and the fake data sources.
import type {
  BranchPageDetail,
  BranchPrCommentsResponse,
  BranchSession,
} from "@repo/api/src/types/branch";
import { BranchCommentsState, BranchStatus } from "@repo/api/src/types/branch";
import type {
  TraceComment,
  TraceCommentDraft,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import { TraceCommentKind } from "@repo/api/src/types/comment";
import type { BranchDetailPageProps } from "../branch-detail-page";

function makeCommentsResponse(branchId: string): BranchPrCommentsResponse {
  return {
    branchId,
    state: BranchCommentsState.UnsyncedUnknown,
    comments: [],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16_384,
      maxResponseBytes: 524_288,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
  };
}

function makeSession(): BranchSession {
  return {
    sessionId: "s1",
    slug: null,
    name: "Session one",
    harness: "claude",
    startedAt: "2026-06-17T10:00:00.000Z",
    endedAt: "2026-06-17T11:00:00.000Z",
    isPrimary: true,
    estimatedCostUsd: 1.23,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ownerUserName: "Session one owner",
  };
}

function makeDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  return {
    id: "b-1",
    branchName: "feature/x",
    baseBranch: "main",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: 42,
    prTitle: "Add x",
    prState: "OPEN",
    prUrl: "https://github.com/owner/repo/pull/42",
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
    lastActivityAt: "2026-06-17T12:00:00.000Z",
    sessionIds: ["s1"],
    prBody: "PR body",
    prBodyHtmlUrl: "https://github.com/owner/repo/pull/42",
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [makeSession()],
    // PLN-1148 Phase 2: detail no longer carries the trace — it's fetched lazily.
    // Keep this empty so the timeline test's "done" assertion can only be
    // satisfied by the lazy `trace` fetch (TRACE_FIXTURE), not a stale read of
    // detail.mergedTrace — guarding against a regression back to eager hydration.
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [42],
    linkedArtifacts: [],
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<BranchDetailPageProps> = {}
): BranchDetailPageProps {
  return {
    branchId: "b-1",
    isLoading: false,
    isError: false,
    backHref: "/branches",
    ...overrides,
  };
}

function makeTraceComment(
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  index: number
): TraceComment {
  const createdAt = new Date(Date.UTC(2026, 5, 17, 10, index)).toISOString();
  return {
    id: `${target.type}-trace-comment-${index}`,
    threadId: `${target.type}-trace-thread-${index}`,
    target,
    artifactId: target.id,
    surface: target.type === "session" ? "session_detail" : "branch_detail",
    ...draft,
    kind: draft.kind ?? TraceCommentKind.Comment,
    status: "OPEN",
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-test",
    authorName: "Test User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

export {
  baseProps,
  makeCommentsResponse,
  makeDetail,
  makeSession,
  makeTraceComment,
};
