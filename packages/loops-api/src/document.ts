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
 * Terminality per Document status, stated for every member so a status added to
 * {@link DocumentStatus} fails `tsc` here until someone decides whether it is
 * terminal. The set below is DERIVED from this map rather than listed beside
 * it: a hand-listed set is widened to `string` and silently answers "not
 * terminal" for any member nobody remembered to add.
 */
const DOCUMENT_STATUS_TERMINALITY: Record<DocumentStatus, boolean> = {
  [DocumentStatus.Draft]: false,
  [DocumentStatus.InReview]: false,
  [DocumentStatus.ChangesRequested]: false,
  [DocumentStatus.Approved]: true,
  [DocumentStatus.Executed]: true,
  [DocumentStatus.Obsolete]: true,
};

/**
 * Terminal Document lifecycle statuses: the document is signed off, executed,
 * or deprecated. Note `APPROVED` is terminal — post-PRD-495 it absorbs the
 * former `DONE` document status.
 *
 * This is a CLASSIFICATION its consumers read — row grouping, quarantine
 * ownership, blocker resolution — and never a write prohibition. ISS-9559
 * recorded that status transitions are any-to-any: the write service enforces
 * that the destination belongs to the subtype's vocabulary and nothing else, so
 * a terminal status can be left again for any other member of that vocabulary.
 *
 * The element type stays `string` deliberately: {@link isTerminalStatusForSubtype}
 * is asked about PERSISTED values, which ISS-9434 recorded can sit outside the
 * vocabulary for their subtype. Membership is what the map above closes.
 */
export const TERMINAL_DOCUMENT_STATUSES: ReadonlySet<string> = new Set<string>(
  DOCUMENT_STATUS_OPTIONS.filter(
    (status) => DOCUMENT_STATUS_TERMINALITY[status]
  )
);

/** Terminality per Issue status. Same exhaustiveness contract as Documents. */
const ISSUE_STATUS_TERMINALITY: Record<IssueStatus, boolean> = {
  [IssueStatus.Triage]: false,
  [IssueStatus.Backlog]: false,
  [IssueStatus.Todo]: false,
  [IssueStatus.InProgress]: false,
  [IssueStatus.InReview]: false,
  [IssueStatus.Blocked]: false,
  [IssueStatus.Done]: true,
  [IssueStatus.Canceled]: true,
};

/** Terminal Feature lifecycle statuses: shipped or won't-do. */
export const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set<string>(
  ISSUE_STATUS_OPTIONS.filter((status) => ISSUE_STATUS_TERMINALITY[status])
);

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
): readonly (DocumentStatus | IssueStatus)[] {
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
 * The CREATE-TIME default status for an artifact whose caller supplied none.
 * Issues default to `BACKLOG`, Documents to `DRAFT`.
 *
 * ISS-9434 narrowed this note. It used to say "safe fallback when a persisted
 * value is outside the vocabulary for an artifact's subtype", which described a
 * read-side repair no caller performs: every call site hands this a REQUESTED
 * subtype and no status (`document-service.ts` `?? fallbackStatusForSubtype(...)`,
 * and the two create modals). Nothing folds a STORED value through it, so an
 * off-vocabulary row — a FEATURE carrying the `DocumentStatus` member `OBSOLETE`
 * was the live example — is still returned raw by the API.
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
  /** Resolved from a branch/PR the artifact actually produced (ISS-8164). */
  BranchLink: "branch_link",
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
export const snapshotSourceSchema = z.enum(SnapshotSource);

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

/**
 * Whether a snapshot's PRIMARY repository was *observed* for this artifact
 * rather than guessed for it (ISS-8164).
 *
 * Deliberately a statement about the primary alone. `branch_link` reconciles a
 * guessed primary to the repository a linked branch resolved, and carries the
 * repositories it replaced forward as `additional` so the branch-write
 * authorization allow-list never shrinks — those carried entries are the old
 * guess, not observations. {@link getPrimaryRepoFromSnapshot} is what a
 * repo-scoped consumer reads, and this predicate is what tells it whether that
 * `fullName` is a measurement.
 *
 * `project_defaults` is a project-level guess made before any branch exists,
 * `parent_artifact` is a copy of another artifact's snapshot (never an
 * observation of this one), and `legacy` predates the provenance field.
 *
 * Rows written before reconciliation existed keep their original source and are
 * disclosed through this predicate rather than rewritten, so a rollup or
 * blast-radius query must filter on it instead of trusting a bare `fullName`.
 */
export function isPrimaryRepoObserved(source: SnapshotSource): boolean {
  return SNAPSHOT_SOURCE_PRIMARY_OBSERVED[source];
}

/**
 * Whether reconciliation may replace a snapshot's primary when a linked branch
 * resolves a different repository (ISS-8164).
 *
 * Strictly narrower than `!isPrimaryRepoObserved`. `parent_artifact` reads
 * unobserved but is NOT correctable: it may carry a human `loop_selection`
 * inherited from the parent, including pinned branches, and the platform cannot
 * tell an inherited choice from an inherited guess.
 * `legacy` is excluded on the same basis and more directly: every such row was
 * minted by the `add_repository_snapshot` backfill from the artifact's own
 * `target_repo`/`target_branch`, which were caller-supplied document fields set
 * from the repo picker — a human choice, not a guess, and the `branch` half is
 * a pin. Promoting a different repository would demote that
 * entry to `additional`, where {@link getPrimaryRepoFromSnapshot} cannot see it.
 * Only a value this artifact never chose and never inherited is correctable.
 */
export function isSnapshotCorrectable(source: SnapshotSource): boolean {
  return SNAPSHOT_SOURCE_CORRECTABLE[source];
}

/**
 * Exhaustive by construction: a new {@link SnapshotSource} member fails `tsc`
 * in both maps until its observedness and its correctability are each stated,
 * instead of defaulting into a side inventory.
 */
const SNAPSHOT_SOURCE_PRIMARY_OBSERVED: Record<SnapshotSource, boolean> = {
  [SnapshotSource.ProjectDefaults]: false,
  [SnapshotSource.LoopSelection]: true,
  [SnapshotSource.ParentArtifact]: false,
  [SnapshotSource.Legacy]: false,
  [SnapshotSource.BranchLink]: true,
  [SnapshotSource.None]: false,
};

const SNAPSHOT_SOURCE_CORRECTABLE: Record<SnapshotSource, boolean> = {
  [SnapshotSource.ProjectDefaults]: true,
  [SnapshotSource.LoopSelection]: false,
  [SnapshotSource.ParentArtifact]: false,
  [SnapshotSource.Legacy]: false,
  [SnapshotSource.BranchLink]: false,
  [SnapshotSource.None]: false,
};
