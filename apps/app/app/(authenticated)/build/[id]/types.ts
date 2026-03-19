/**
 * Stub types for Branch view UI. Replace with API types when wiring real data.
 */

export type StubChangedFile = {
  path: string;
  status: "added" | "modified" | "removed";
  additions?: number;
  deletions?: number;
};

export type StubPrCommentAuthorKind = "user" | "bot";

export type StubPrComment = {
  id: string;
  author: string;
  /** Photo URL for user avatars (stub). */
  authorAvatar?: string;
  /** Bot comments use icon tile like the design mock. */
  authorKind?: StubPrCommentAuthorKind;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  isResolved: boolean;
  replies: StubPrComment[];
};

export type StubBranchViewData = {
  externalLinkId: string;
  prTitle: string;
  externalUrl: string;
  featureSlug: string;
  featureTitle: string;
  teamId: string | null;
  teamName: string | null;
  projectId: string | null;
  projectName: string | null;
  isAuthor: boolean;
  producedByPlanSlug: string | null;
  producedByPlanTitle: string | null;
  committedFiles: StubChangedFile[];
  localFiles: StubChangedFile[];
  comments: StubPrComment[];
  prState: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checksStatus: "PASSING" | "FAILING" | "PENDING" | null;
};
