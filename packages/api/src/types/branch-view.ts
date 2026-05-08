/**
 * Branch View API types.
 * Used by both apps/api (backend) and apps/app (frontend).
 */

import type { GitHubPRState } from "./github";

// --- Const objects mirroring Prisma enums for frontend use ---

export const PRReviewCommentState = {
  Pending: "PENDING",
  Addressed: "ADDRESSED",
  Dismissed: "DISMISSED",
} as const;
export type PRReviewCommentState =
  (typeof PRReviewCommentState)[keyof typeof PRReviewCommentState];

export const ReviewDecision = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Commented: "COMMENTED",
  Dismissed: "DISMISSED",
} as const;
export type ReviewDecision =
  (typeof ReviewDecision)[keyof typeof ReviewDecision];

export const ChecksStatus = {
  Unknown: "UNKNOWN",
  Pending: "PENDING",
  Passing: "PASSING",
  Failing: "FAILING",
} as const;
export type ChecksStatus = (typeof ChecksStatus)[keyof typeof ChecksStatus];

export const FileChangeStatus = {
  Added: "added",
  Modified: "modified",
  Removed: "removed",
  Renamed: "renamed",
  Copied: "copied",
} as const;
export type FileChangeStatus =
  (typeof FileChangeStatus)[keyof typeof FileChangeStatus];

export const PrCommentAuthorKind = {
  User: "user",
  Bot: "bot",
} as const;
export type PrCommentAuthorKind =
  (typeof PrCommentAuthorKind)[keyof typeof PrCommentAuthorKind];

// --- Data types ---

export type BranchViewFile = {
  path: string;
  previousPath: string | null;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  patch: string | null;
};

export const CommentKind = {
  ReviewComment: "review_comment",
  IssueComment: "issue_comment",
} as const;
export type CommentKind = (typeof CommentKind)[keyof typeof CommentKind];

export type BranchViewComment = {
  id: string;
  githubCommentId: string;
  author: string;
  authorAvatar: string | null;
  authorKind: PrCommentAuthorKind;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  state: PRReviewCommentState;
  reviewId: string | null;
  htmlUrl: string;
  inReplyToId: string | null;
  kind: CommentKind;
};

export type BranchViewReview = {
  id: string;
  author: string;
  authorAvatar: string | null;
  state: ReviewDecision;
  body: string | null;
  submittedAt: string;
  htmlUrl: string;
};

export type BranchViewData = {
  externalLinkId: string;
  prTitle: string;
  externalUrl: string;
  prNumber: number;
  prHtmlUrl: string;
  featureSlug: string | null;
  featureTitle: string | null;
  teamId: string | null;
  teamName: string | null;
  projectId: string | null;
  projectName: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  prState: GitHubPRState;
  reviewDecision: ReviewDecision | null;
  checksStatus: ChecksStatus | null;
  isDraft: boolean;
  authorLogin: string | null;
  isAuthor: boolean;
  repoFullName: string;
  committedFiles: BranchViewFile[];
  reviews: BranchViewReview[];
  comments: BranchViewComment[];
  producedByPlanSlug: string | null;
  producedByPlanTitle: string | null;
};

export type BranchViewFileDiff = {
  path: string;
  oldContent: string;
  newContent: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
};

export type ReplyToCommentInput = {
  commentGithubId: number;
  body: string;
};

export type ReplyToCommentResponse = BranchViewComment;
