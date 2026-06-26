import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import type {
  FeedItem,
  FeedItemKind,
} from "@repo/app/documents/components/feed-sidebar/feed-item";
import type {
  BranchReviewFinding,
  BranchReviewFindingAnchorClassification,
} from "../components/branch-review-findings";
import type { ResolvedCommentFileTarget } from "../file-targets";

/** Threaded PR comment row, one per thread root, replies denormalized. */
export type PrCommentItem = FeedItem & {
  kind: typeof FeedItemKind.PrComment;
  threadId: string;
  root: BranchViewComment;
  replies: readonly BranchViewComment[];
  finding: BranchReviewFinding | null;
  findingAnchor: BranchReviewFindingAnchorClassification | null;
  commentFileTarget: ResolvedCommentFileTarget | null;
};

/** Tab values for the PR source's sub-filter. */
export const PrFilterTab = {
  All: "all",
  Pending: "pending",
  Findings: "findings",
  Resolved: "resolved",
} as const;
export type PrFilterTab = (typeof PrFilterTab)[keyof typeof PrFilterTab];

export type PrFilterState = { tab: PrFilterTab };

export const DEFAULT_PR_FILTER_STATE: PrFilterState = {
  tab: PrFilterTab.All,
};
