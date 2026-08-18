import { z } from "zod";

export const DocumentType = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
  Feature: "FEATURE",
  Doc: "DOC",
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];
export const DOCUMENT_TYPE_OPTIONS = Object.values(DocumentType);

/**
 * Canonical *persisted* document type ({@link DocumentType}) plus the `ISSUE`
 * input alias (ISS-4397). The product renamed Features → Issues in the UI and
 * routes (FEA-3954/FEA-4137: `DocumentType.Feature` already displays as "Issue",
 * mints `ISS-###` slugs, and routes under `/issues/`), but the underlying
 * storage subtype stays `FEATURE`. This *input* vocabulary is what the REST API
 * and MCP tools accept from callers; a caller may pass `ISSUE` or `FEATURE` and
 * both resolve to the same `FEATURE`-typed artifacts.
 *
 * `ISSUE` is deliberately NOT a member of {@link DocumentType}: it never
 * persists (it normalizes to `FEATURE` at the API/MCP boundary via
 * {@link normalizeDocumentType} before it reaches Prisma or any exhaustive
 * `Record<DocumentType, …>` map), so existing FEATURE-typed rows, the
 * `IssueStatus` vocabulary, slug prefixes, and every `subtype === FEATURE`
 * predicate keep working unchanged. Additive and skew-safe: old clients that
 * only know `FEATURE` are unaffected, and new clients may use `ISSUE`.
 */
export const DocumentTypeAlias = {
  Issue: "ISSUE",
} as const;
export type DocumentTypeAlias =
  (typeof DocumentTypeAlias)[keyof typeof DocumentTypeAlias];

/**
 * The accepted *input* document-type vocabulary: every persisted
 * {@link DocumentType} plus the `ISSUE` alias. Callers of the REST API and MCP
 * tools validate against this superset; the value is normalized to a persisted
 * {@link DocumentType} with {@link normalizeDocumentType} before use.
 */
export const DocumentTypeInput = {
  ...DocumentType,
  ...DocumentTypeAlias,
} as const;
export type DocumentTypeInput =
  (typeof DocumentTypeInput)[keyof typeof DocumentTypeInput];
export const DOCUMENT_TYPE_INPUT_OPTIONS = Object.values(DocumentTypeInput);

/**
 * Maps every accepted input document-type ({@link DocumentTypeInput}) to the
 * persisted {@link DocumentType} used for storage and queries. Only the `ISSUE`
 * alias is remapped (→ `FEATURE`); every canonical type maps to itself. Exported
 * as an exhaustive `Record` so the compiler forces a mapping decision the moment
 * a new input type is added to {@link DocumentTypeInput}.
 */
export const DOCUMENT_TYPE_INPUT_TO_CANONICAL: Record<
  DocumentTypeInput,
  DocumentType
> = {
  [DocumentType.Prd]: DocumentType.Prd,
  [DocumentType.ImplementationPlan]: DocumentType.ImplementationPlan,
  [DocumentType.Template]: DocumentType.Template,
  [DocumentType.Feature]: DocumentType.Feature,
  [DocumentType.Doc]: DocumentType.Doc,
  // ISS-4397: the `ISSUE` input alias resolves to the persisted `FEATURE`
  // subtype (the product's "Issue" is a display/route rename of Feature).
  [DocumentTypeAlias.Issue]: DocumentType.Feature,
};

/**
 * Normalizes an accepted input document type to its persisted
 * {@link DocumentType}. `ISSUE` → `FEATURE`; every other value is returned
 * unchanged. Call this at the API/MCP boundary before persisting or querying so
 * the alias never leaks into the database or into a `Record<DocumentType, …>`
 * map. (ISS-4397.)
 */
export function normalizeDocumentType(type: DocumentTypeInput): DocumentType {
  return DOCUMENT_TYPE_INPUT_TO_CANONICAL[type];
}

/** Shared inline-image limits used by document create and version APIs. */
export const MAX_DOCUMENT_VERSION_INLINE_IMAGES = 5;
export const MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS = 255;
export const MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS = 200;
export const MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS = 500;
export const MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS = 1_048_576;
export const MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES = 1_048_576;

/**
 * Status vocabulary for Documents (PRD, IMPLEMENTATION_PLAN, TEMPLATE, DOC) — an
 * authoring/approval lifecycle. Distinct from {@link IssueStatus}, which is
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
export const IssueStatus = {
  Triage: "TRIAGE",
  Backlog: "BACKLOG",
  Todo: "TODO",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Blocked: "BLOCKED",
  Done: "DONE",
  Canceled: "CANCELED",
} as const;
export type IssueStatus = (typeof IssueStatus)[keyof typeof IssueStatus];
export const ISSUE_STATUS_OPTIONS = Object.values(IssueStatus);
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
export const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set<string>([
  IssueStatus.Done,
  IssueStatus.Canceled,
]);

/**
 * Whether a persisted `subtype` follows the Issue (delivery) lifecycle rather
 * than the Document (authoring) lifecycle. The persisted subtype is `FEATURE`,
 * but the widened Prisma enum also permits the canonical `ISSUE` value (FEA-3956
 * Phase 3): no code path persists `ISSUE` (writes normalize it to `FEATURE` at
 * the boundary), yet a version-skewed or direct write could still land an
 * `ISSUE` row. Classifying both here — the single discriminator the three
 * lifecycle selectors below share — keeps a stray stored `ISSUE` on the Issue
 * vocabulary instead of silently falling through to the Document lifecycle
 * (which would accept `APPROVED` / reject `DONE` and mis-terminate blockers).
 */
export function isIssueLifecycleSubtype(
  subtype: string | null | undefined
): boolean {
  return (
    subtype === DocumentType.Feature || subtype === DocumentTypeAlias.Issue
  );
}

/**
 * Selects the status vocabulary for an artifact by its `subtype`. Issues
 * (persisted subtype = FEATURE, or a stray canonical `ISSUE`) use
 * {@link IssueStatus}; every other Document subtype (PRD, IMPLEMENTATION_PLAN,
 * TEMPLATE, DOC) uses {@link DocumentStatus}. This is the single discriminator
 * the validators, client guard, and UI config key off.
 */
export function statusOptionsForSubtype(
  subtype: string | null | undefined
): readonly string[] {
  return isIssueLifecycleSubtype(subtype)
    ? ISSUE_STATUS_OPTIONS
    : DOCUMENT_STATUS_OPTIONS;
}

/** Whether a status string is terminal for the given artifact subtype. */
export function isTerminalStatusForSubtype(
  subtype: string | null | undefined,
  status: string
): boolean {
  return isIssueLifecycleSubtype(subtype)
    ? TERMINAL_ISSUE_STATUSES.has(status)
    : TERMINAL_DOCUMENT_STATUSES.has(status);
}

/**
 * Safe fallback status when a persisted value is outside the vocabulary for an
 * artifact's subtype (the freeform column has no DB-level guarantee). Issues
 * fall back to `BACKLOG`, Documents to `DRAFT`.
 */
export function fallbackStatusForSubtype(
  subtype: string | null | undefined
): DocumentStatus | IssueStatus {
  return isIssueLifecycleSubtype(subtype)
    ? IssueStatus.Backlog
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
