import { z } from "zod";

export const DocumentType = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
  Feature: "FEATURE",
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];
export const DOCUMENT_TYPE_OPTIONS = Object.values(DocumentType);

/**
 * Status vocabulary for Documents (PRD, IMPLEMENTATION_PLAN, TEMPLATE) — an
 * authoring/approval lifecycle. Distinct from {@link FeatureStatus}, which is
 * the delivery lifecycle for Features. Both vocabularies persist into the same
 * freeform `Artifact.status` String column; the correct set is selected by the
 * artifact's `subtype` (see {@link statusOptionsForSubtype}). See PRD-495.
 */
export const DocumentStatus = {
  Draft: "DRAFT",
  InReview: "IN_REVIEW",
  ChangesRequested: "CHANGES_REQUESTED",
  Approved: "APPROVED",
  Executed: "EXECUTED",
  Obsolete: "OBSOLETE",
} as const;
export type DocumentStatus =
  (typeof DocumentStatus)[keyof typeof DocumentStatus];
export const DOCUMENT_STATUS_OPTIONS = Object.values(DocumentStatus);

/**
 * Status vocabulary for Features (subtype = FEATURE) — a delivery /
 * issue-tracker lifecycle. Distinct from {@link DocumentStatus}. `TRIAGE` is
 * reserved for agent-generated Features awaiting human assessment; `BACKLOG`
 * is the default for human-created Features. See PRD-495.
 */
export const FeatureStatus = {
  Triage: "TRIAGE",
  Backlog: "BACKLOG",
  Todo: "TODO",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Blocked: "BLOCKED",
  Done: "DONE",
  Canceled: "CANCELED",
} as const;
export type FeatureStatus = (typeof FeatureStatus)[keyof typeof FeatureStatus];
export const FEATURE_STATUS_OPTIONS = Object.values(FeatureStatus);
// `TRIAGE` is selectable by humans in every status menu; it is only excluded as
// the human-create *default* (humans default to `BACKLOG`, agents to `TRIAGE`).
// That default lives in the create paths, not in a separate options list.

/**
 * Terminal Document lifecycle statuses: the document is signed off, executed,
 * or deprecated and will not progress further. Note `APPROVED` is terminal —
 * post-PRD-495 it absorbs the former `DONE` document status.
 */
export const TERMINAL_DOCUMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  DocumentStatus.Obsolete,
]);

/** Terminal Feature lifecycle statuses: shipped or won't-do. */
export const TERMINAL_FEATURE_STATUSES: ReadonlySet<string> = new Set<string>([
  FeatureStatus.Done,
  FeatureStatus.Canceled,
]);

/**
 * Selects the status vocabulary for an artifact by its `subtype`. Features
 * (subtype = FEATURE) use {@link FeatureStatus}; every other Document subtype
 * (PRD, IMPLEMENTATION_PLAN, TEMPLATE) uses {@link DocumentStatus}. This is the
 * single discriminator the validators, client guard, and UI config key off.
 */
export function statusOptionsForSubtype(
  subtype: string | null | undefined
): readonly string[] {
  return subtype === DocumentType.Feature
    ? FEATURE_STATUS_OPTIONS
    : DOCUMENT_STATUS_OPTIONS;
}

/** Whether a status string is terminal for the given artifact subtype. */
export function isTerminalStatusForSubtype(
  subtype: string | null | undefined,
  status: string
): boolean {
  return subtype === DocumentType.Feature
    ? TERMINAL_FEATURE_STATUSES.has(status)
    : TERMINAL_DOCUMENT_STATUSES.has(status);
}

/**
 * Safe fallback status when a persisted value is outside the vocabulary for an
 * artifact's subtype (the freeform column has no DB-level guarantee). Features
 * fall back to `BACKLOG`, Documents to `DRAFT`.
 */
export function fallbackStatusForSubtype(
  subtype: string | null | undefined
): DocumentStatus | FeatureStatus {
  return subtype === DocumentType.Feature
    ? FeatureStatus.Backlog
    : DocumentStatus.Draft;
}

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
