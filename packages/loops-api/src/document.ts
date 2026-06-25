import { z } from "zod";

export const DocumentType = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
  Feature: "FEATURE",
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];
export const DOCUMENT_TYPE_OPTIONS = Object.values(DocumentType);

export const DocumentStatus = {
  Draft: "DRAFT",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Approved: "APPROVED",
  Executed: "EXECUTED",
  Done: "DONE",
  Obsolete: "OBSOLETE",
} as const;
export type DocumentStatus =
  (typeof DocumentStatus)[keyof typeof DocumentStatus];
export const DOCUMENT_STATUS_OPTIONS = Object.values(DocumentStatus);

export const ChecksStatus = {
  Unknown: "UNKNOWN",
  Pending: "PENDING",
  Passing: "PASSING",
  Failing: "FAILING",
} as const;
export type ChecksStatus = (typeof ChecksStatus)[keyof typeof ChecksStatus];

export const SnapshotSource = {
  ProjectDefaults: "project_defaults",
  LoopSelection: "loop_selection",
  ParentArtifact: "parent_artifact",
  Legacy: "legacy",
  None: "none",
} as const;
export type SnapshotSource =
  (typeof SnapshotSource)[keyof typeof SnapshotSource];

export const RepositoryRole = {
  Primary: "primary",
  Additional: "additional",
} as const;
export type RepositoryRole =
  (typeof RepositoryRole)[keyof typeof RepositoryRole];

const repositoryRoleSchema = z.enum(RepositoryRole);
const snapshotSourceSchema = z.enum(SnapshotSource);

export const artifactRepositoryEntrySchema = z.object({
  fullName: z.string().min(1),
  role: repositoryRoleSchema,
  position: z.number().int().nonnegative(),
  branch: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
});

export const artifactRepositorySnapshotSchema = z.object({
  repositories: z.array(artifactRepositoryEntrySchema),
  source: snapshotSourceSchema,
  createdAt: z.union([z.string(), z.date()]).optional(),
});

export type ArtifactRepositoryEntry = z.infer<
  typeof artifactRepositoryEntrySchema
>;
export type ArtifactRepositorySnapshot = z.infer<
  typeof artifactRepositorySnapshotSchema
>;

export const PullRequestState = {
  Open: "OPEN",
  Merged: "MERGED",
  Closed: "CLOSED",
} as const;
export type PullRequestState =
  (typeof PullRequestState)[keyof typeof PullRequestState];

export const ReviewDecision = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Commented: "COMMENTED",
  Dismissed: "DISMISSED",
} as const;
export type ReviewDecision =
  (typeof ReviewDecision)[keyof typeof ReviewDecision];

export type PullRequestInfo = {
  id: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: PullRequestState;
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  createdAt: Date;
  checksStatus: ChecksStatus | null;
  reviewDecision: ReviewDecision | null;
  externalLinkId: string | null;
  repoFullName: string | null;
};
