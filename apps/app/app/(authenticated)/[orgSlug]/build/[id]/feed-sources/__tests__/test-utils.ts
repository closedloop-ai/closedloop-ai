import {
  type BranchViewComment,
  type BranchViewData,
  type BranchViewFile,
  ChecksStatus,
  CommentKind,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { BranchViewContextValue } from "../../branch-view-context";

export type StubMutation = {
  mutate: Mock;
  isPending: boolean;
  variables: undefined;
};

/** Build a `BranchViewComment` with sensible defaults for tests. */
export function makeComment(
  overrides: Partial<BranchViewComment> = {}
): BranchViewComment {
  return {
    id: "c_1",
    githubCommentId: "1",
    author: "octocat",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
    body: "body",
    createdAt: "2026-01-01T00:00:00Z",
    path: null,
    line: null,
    state: PRReviewCommentState.Pending,
    reviewId: null,
    htmlUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
    inReplyToId: null,
    kind: CommentKind.IssueComment,
    ...overrides,
  } satisfies BranchViewComment;
}

/** Build a `BranchViewData` payload with sensible defaults for tests. */
export function makeBranchData(
  comments: BranchViewComment[] = [],
  committedFiles: BranchViewFile[] = []
): BranchViewData {
  return {
    externalLinkId: "ext_1",
    branch: null,
    currentPullRequest: null,
    prTitle: "Title",
    externalUrl: "https://example.com/pr",
    prNumber: 42,
    prHtmlUrl: "https://example.com/pr",
    featureSlug: null,
    featureTitle: null,
    teamId: null,
    teamName: null,
    projectId: null,
    projectName: null,
    headBranch: "feature/x",
    baseBranch: "main",
    headSha: null,
    prState: GitHubPRState.Open,
    reviewDecision: null,
    checksStatus: ChecksStatus.Passing,
    isDraft: false,
    authorLogin: null,
    isAuthor: false,
    canCreateConversationComment: true,
    canCreateInlineComment: true,
    repoFullName: "owner/repo",
    committedFiles,
    reviews: [],
    comments,
    producedByPlanSlug: null,
    producedByPlanTitle: null,
  };
}

/** Minimal TanStack-mutation shape used by every branch-view context fixture. */
export function makeMutation(): StubMutation {
  return {
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  };
}

/**
 * Build a `BranchViewContextValue` for tests. Casts through `unknown` because
 * partial TanStack-mutation shapes are intentional in tests — the production
 * shapes carry many fields no test under examination touches.
 */
export function makeBranchViewContextValue(input: {
  comments: BranchViewComment[];
  committedFiles?: BranchViewFile[];
  selectedCommentId?: string | null;
  syncControl?: Partial<BranchViewContextValue["syncControl"]>;
}): BranchViewContextValue {
  const committedFiles = input.committedFiles ?? [];
  const syncControl = {
    isBranchSyncPending: false,
    isCommentsSyncPending: false,
    refreshBranch: vi.fn(),
    refreshComments: vi.fn(),
    syncRetryState: null,
    ...input.syncControl,
  };
  return {
    data: makeBranchData(input.comments, committedFiles),
    comments: input.comments,
    committedFiles,
    headSha: null,
    fileCacheHeadSha: null,
    externalLinkId: "ext_1",
    prNumber: 42,
    selectedCommentId: input.selectedCommentId ?? null,
    onSelectComment: vi.fn(),
    onSelectCommentDiffTarget: vi.fn(),
    canCreateConversationComment: true,
    syncControl,
    mutations: {
      reply: makeMutation(),
      createConversation: makeMutation(),
      editConversation: makeMutation(),
      deleteConversation: makeMutation(),
      editReview: makeMutation(),
      deleteReview: makeMutation(),
      resolveThread: makeMutation(),
      unresolveThread: makeMutation(),
    },
  } as unknown as BranchViewContextValue;
}
