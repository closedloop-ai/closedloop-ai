import {
  DOCUMENT_STATUS_OPTIONS as SHARED_DOCUMENT_STATUS_OPTIONS,
  DOCUMENT_TYPE_INPUT_OPTIONS as SHARED_DOCUMENT_TYPE_INPUT_OPTIONS,
  DOCUMENT_TYPE_OPTIONS as SHARED_DOCUMENT_TYPE_OPTIONS,
  ISSUE_STATUS_OPTIONS as SHARED_ISSUE_STATUS_OPTIONS,
  MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS as SHARED_MAX_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS as SHARED_MAX_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS as SHARED_MAX_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS as SHARED_MAX_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGES as SHARED_MAX_DOCUMENT_INLINE_IMAGES,
  MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES as SHARED_MAX_DOCUMENT_INLINE_REQUEST_BODY_BYTES,
  TERMINAL_DOCUMENT_STATUSES as SHARED_TERMINAL_DOCUMENT_STATUSES,
  TERMINAL_ISSUE_STATUSES as SHARED_TERMINAL_ISSUE_STATUSES,
  ChecksStatus as SharedChecksStatus,
  DocumentStatus as SharedDocumentStatus,
  DocumentType as SharedDocumentType,
  DocumentTypeAlias as SharedDocumentTypeAlias,
  DocumentTypeInput as SharedDocumentTypeInput,
  IssueStatus as SharedIssueStatus,
  PullRequestState as SharedPullRequestState,
  RepositoryRole as SharedRepositoryRole,
  ReviewDecision as SharedReviewDecision,
  SnapshotSource as SharedSnapshotSource,
  artifactRepositoryEntrySchema as sharedArtifactRepositoryEntrySchema,
  artifactRepositorySnapshotSchema as sharedArtifactRepositorySnapshotSchema,
  fallbackStatusForSubtype as sharedFallbackStatusForSubtype,
  isTerminalStatusForSubtype as sharedIsTerminalStatusForSubtype,
  normalizeDocumentType as sharedNormalizeDocumentType,
  statusOptionsForSubtype as sharedStatusOptionsForSubtype,
} from "@closedloop-ai/loops-api/document";
import { z } from "zod";
import type { Priority } from "./common.js";
import type { CustomFieldValueDetail } from "./custom-field.js";
import type {
  CreateDocumentVersionInlineImageInput,
  CreatedDocumentVersionInlineImage,
  DocumentVersion,
} from "./document-version.js";
import type { TagSummary } from "./tag.js";
import type { BasicUser } from "./user.js";

export const artifactRepositoryEntrySchema =
  sharedArtifactRepositoryEntrySchema;
export const artifactRepositorySnapshotSchema =
  sharedArtifactRepositorySnapshotSchema;
export const ChecksStatus = SharedChecksStatus;
export const DocumentStatus = SharedDocumentStatus;
export const DOCUMENT_STATUS_OPTIONS = SHARED_DOCUMENT_STATUS_OPTIONS;
export const IssueStatus = SharedIssueStatus;
export const ISSUE_STATUS_OPTIONS = SHARED_ISSUE_STATUS_OPTIONS;
export const DocumentType = SharedDocumentType;
export const DOCUMENT_TYPE_OPTIONS = SHARED_DOCUMENT_TYPE_OPTIONS;
// ISS-4397: the `ISSUE` input alias + the accepted-input superset and its
// normalizer. Re-exported from the loops-api SSOT so both apps/api and the MCP
// server import the boundary vocabulary from one place.
export const DocumentTypeAlias = SharedDocumentTypeAlias;
export const DocumentTypeInput = SharedDocumentTypeInput;
export const DOCUMENT_TYPE_INPUT_OPTIONS = SHARED_DOCUMENT_TYPE_INPUT_OPTIONS;
export const normalizeDocumentType = sharedNormalizeDocumentType;
export const statusOptionsForSubtype = sharedStatusOptionsForSubtype;
export const fallbackStatusForSubtype = sharedFallbackStatusForSubtype;
export const isTerminalStatusForSubtype = sharedIsTerminalStatusForSubtype;
export const PullRequestState = SharedPullRequestState;
export const RepositoryRole = SharedRepositoryRole;
export const ReviewDecision = SharedReviewDecision;
export const SnapshotSource = SharedSnapshotSource;

export type ArtifactRepositoryEntry = z.infer<
  typeof artifactRepositoryEntrySchema
>;
export type ArtifactRepositorySnapshot = z.infer<
  typeof artifactRepositorySnapshotSchema
>;
export type ChecksStatus = (typeof ChecksStatus)[keyof typeof ChecksStatus];
export type DocumentStatus =
  (typeof DocumentStatus)[keyof typeof DocumentStatus];
export type IssueStatus = (typeof IssueStatus)[keyof typeof IssueStatus];

/**
 * Any per-subtype lifecycle status that can persist on `Artifact.status`.
 * Documents use {@link DocumentStatus}; Features use {@link IssueStatus}
 * (PRD-495). The two sets overlap on `IN_REVIEW`. Surfaces that handle both
 * artifact kinds (the create/update inputs, the `Document` projection) type
 * `status` as this union and narrow by `subtype` where the distinction matters.
 */
export type ArtifactStatus = DocumentStatus | IssueStatus;

/**
 * Terminal Document lifecycle statuses: the document is signed off, executed,
 * or deprecated and will not progress further. Canonical definition for "is
 * this document resolved?" checks (e.g. dependency/blocker gating). Re-exported
 * from the loops-api SSOT. Post-PRD-495 `APPROVED` is terminal (absorbs `DONE`).
 */
export const TERMINAL_DOCUMENT_STATUSES = SHARED_TERMINAL_DOCUMENT_STATUSES;

/** Terminal Feature lifecycle statuses: shipped (`DONE`) or won't-do (`CANCELED`). */
export const TERMINAL_ISSUE_STATUSES = SHARED_TERMINAL_ISSUE_STATUSES;

// Per-vocabulary terminal predicates were intentionally dropped (PRD-495): the
// single combined entry point is `isTerminalStatusForSubtype(subtype, status)`,
// which callers use everywhere a status's terminality is checked.
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];
export type DocumentTypeAlias =
  (typeof DocumentTypeAlias)[keyof typeof DocumentTypeAlias];
export type DocumentTypeInput =
  (typeof DocumentTypeInput)[keyof typeof DocumentTypeInput];
export type PullRequestState =
  (typeof PullRequestState)[keyof typeof PullRequestState];
export type RepositoryRole =
  (typeof RepositoryRole)[keyof typeof RepositoryRole];
export type ReviewDecision =
  (typeof ReviewDecision)[keyof typeof ReviewDecision];
export type SnapshotSource =
  (typeof SnapshotSource)[keyof typeof SnapshotSource];

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
 * Maps document types to their URL route prefixes.
 * Single source of truth for type->route mapping used by:
 * - apps/app/lib/artifact-navigation.ts (frontend navigation)
 * - apps/app/app/(authenticated)/artifacts/[slug]/page.tsx (redirect fallback)
 * - packages/collaboration/room-metadata.ts (Liveblocks notification URLs)
 */
export const TYPE_ROUTE_PREFIX: Partial<Record<DocumentType, string>> = {
  [DocumentType.Prd]: "prds",
  [DocumentType.ImplementationPlan]: "implementation-plans",
  // FEA-4137: the Feature artifact is now "Issue" and routes under /issues/. The
  // legacy /features/[slug] route is retained as a redirect (deep-link and query
  // params preserved) so old links keep working during the migration.
  [DocumentType.Feature]: "issues",
  [DocumentType.Doc]: "documents",
};

/**
 * FEA-4137: retired route-path aliases per document type, kept so old deep links
 * keep resolving during the Feature → Issue migration. The Feature detail route
 * moved from `/features/` to `/issues/`; `/features/[slug]` now redirects to the
 * `/issues/` equivalent (ISS-4570: 308 once the path carries its org prefix, 302
 * while it must still inject the caller's — `apps/app/lib/app-route-redirects.ts`
 * owns that choice). Single source of truth for the legacy path — the
 * redirect route and the GitHub artifact-reference URL parser both read it, so a
 * future prefix rename only edits this map. Do NOT drop an entry without human
 * approval (external bookmarks and PR bodies still carry the legacy path).
 */
export const LEGACY_TYPE_ROUTE_PREFIXES: Partial<
  Record<DocumentType, readonly string[]>
> = {
  [DocumentType.Feature]: ["features"],
};

/**
 * Returns the route prefix for a navigable document type, or null if not navigable.
 * Accepts raw strings (e.g. from Liveblocks room metadata) in addition to typed values.
 */
export function getRoutePrefixForType(type: string): string | null {
  if (type in TYPE_ROUTE_PREFIX) {
    return TYPE_ROUTE_PREFIX[type as DocumentType] ?? null;
  }
  return null;
}

/**
 * Return the primary repository entry from a snapshot, or null when the
 * snapshot is empty (`source: 'none'`). Consumers that only need the single
 * primary repo (chat panel local-fs lookup, PR ordering, plan-editor primary
 * PR selection) use this helper rather than reaching into `repositories[0]`.
 */
export function getPrimaryRepoFromSnapshot(
  snapshot: ArtifactRepositorySnapshot | null | undefined
): ArtifactRepositoryEntry | null {
  return (
    snapshot?.repositories.find((r) => r.role === RepositoryRole.Primary) ??
    snapshot?.repositories[0] ??
    null
  );
}

export type Document = {
  id: string;
  organizationId: string;
  projectId: string | null;
  type: DocumentType;
  title: string;
  slug: string;
  fileName: string | null;
  status: ArtifactStatus;
  priority: Priority;
  latestVersion: number;
  createdById: string;
  /** Original artifact creator summary. Null when the creator record is unavailable. */
  createdBy?: BasicUser | null;
  assigneeId: string | null;
  assignee: BasicUser | null;
  /** Optional document due date. Omitted by older API deploys during version skew. */
  dueDate?: Date | null;
  approverId: string | null;
  approver: BasicUser | null;
  /**
   * Immutable per-document record of the repositories this artifact was
   * created against. Populated server-side at creation time and never
   * editable through `PATCH /documents/:id`. Always present post-backfill
   * (PLN-602) — documents without any resolved repos carry `source: 'none'`
   * with an empty `repositories` array.
   */
  repositorySnapshot: ArtifactRepositorySnapshot;
  templateForType: DocumentType | null;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentWithProject = Document & {
  project?: {
    id: string;
    name: string;
    teams?: { id: string; name: string }[];
  } | null;
  /** The latest generation status for this document. Omitted when no generation status is available. */
  generationStatus?: GenerationStatus;
  /** Custom field values attached to this document. Omitted when not requested. */
  customFields?: CustomFieldValueDetail[];
  tags?: TagSummary[];
};

/** Detail response from GET /documents/:id and GET /documents/by-slug/:slug. Always includes selected version content. */
export type DocumentDetail = DocumentWithProject & {
  version: DocumentVersion;
  /**
   * Saved content for the current latest version, even when `version` is a
   * historical selection. Consumers that need latest-version invariants must
   * read this field instead of assuming `version.content` is latest content.
   */
  latestVersionContent: string | null;
};

export type FindDocumentsOptions = {
  /**
   * Accepted request-side document-type filter: the persisted
   * {@link DocumentType} superset plus the `ISSUE` alias ({@link DocumentTypeInput},
   * ISS-4397). A typed caller (e.g. `useDocuments`) may pass `type=ISSUE` or
   * `type=FEATURE`; both resolve to FEATURE-typed artifacts. The value is
   * normalized to a persisted {@link DocumentType} at the boundary
   * ({@link normalizeDocumentType}) before it reaches the Prisma `where`, so the
   * alias never becomes a `subtype` filter.
   */
  type?: DocumentTypeInput;
  projectId?: string;
  assigneeId?: string;
  /**
   * When true, return only project-less (org-level / evergreen) documents —
   * those with `projectId === null`. Used by the org-level Documents index
   * (FEA-4140), which lists DOC artifacts that are not attached to any project.
   * Mutually exclusive with `projectId`: passing a concrete `projectId` already
   * scopes to that project, so this flag only applies when no project is given.
   */
  unassignedProject?: boolean;
  /**
   * Maximum number of documents to return, newest first (FEA-4373). The bound
   * is **opt-in**: when omitted the endpoint returns every matching artifact (the
   * long-standing default the Documents index, plan/document pickers, and
   * version-skewed API clients depend on to show and select older artifacts). A
   * caller passes `limit` only when it renders one row/card per artifact and
   * could crash on a very large set — today only the My Tasks board — and the
   * service clamps the supplied value to [1, {@link DOCUMENT_LIST_MAX_LIMIT}].
   * Callers that page pass `offset` alongside.
   */
  limit?: number;
  /**
   * Zero-based offset for paging (FEA-4373). Only honored alongside `limit`
   * (an offset into an unbounded result is meaningless). Clamped to
   * [0, {@link DOCUMENT_LIST_MAX_OFFSET}].
   */
  offset?: number;
  /**
   * Recency window in days, applied to `Artifact.updatedAt` (FEA-1626).
   *
   * **Omission means no window at all**, on every arm — the full-history
   * contract the Documents index, pickers, the MCP `list-documents` tool, and
   * version-skewed API-key clients depend on. Windowing is opt-IN: a client that
   * wants a bounded read names the day count. That polarity is deliberate and
   * deploy-order-driven (wongk review): `apps/app` and `apps/api` ship
   * independently, so a server-side default would narrow the already-deployed
   * old app's response before any client flag could control it, and an old app's
   * request is indistinguishable from a new client's flag-off request.
   *
   * {@link DocumentListRecency.All} is the explicit spelling of "no window". It
   * behaves identically to omission and exists so a client that is deliberately
   * dropping a window (the My Tasks recency chip's remove action) can say so on
   * the wire.
   *
   * A supplied day count is clamped to
   * [{@link DOCUMENT_LIST_MIN_RECENCY_DAYS}, {@link DOCUMENT_LIST_MAX_RECENCY_DAYS}].
   */
  recencyDays?: DocumentListRecencyDays;
  /**
   * Whether artifacts whose parent project is `ARCHIVED` are included
   * (FEA-1626).
   *
   * **Omission — and `true` — mean "include them"**, the long-standing
   * behavior; only an explicit `false` drops them, for the same deploy-skew
   * reason {@link FindDocumentsOptions.recencyDays} documents. The exclusion is
   * also skipped when a concrete `projectId` was requested — asking for a
   * specific project is an explicit choice the server does not second-guess.
   *
   * Project-LESS artifacts (`projectId === null`, e.g. org-level Documents and
   * Templates) are never archived and are always kept: a naive
   * `project: { status: { not: ARCHIVED } }` relation filter would drop every
   * one of them, because a nullable to-one relation filter matches only rows
   * that HAVE a related row.
   */
  includeArchivedProjects?: boolean;
};

/**
 * Filter set PLUS the response-shape discriminator for the paged read
 * (`GET /documents?includeTotal=true`, ISS-4576).
 *
 * `includeTotal` is deliberately NOT a member of {@link FindDocumentsOptions}
 * (shafty023 review): it selects the response ARM (envelope vs bare array), it is
 * not a query predicate, so putting it on the filter type made
 * `useDocuments({ includeTotal: true })` — a hook that promises
 * `DocumentWithProject[]` — type-check while the server returned the envelope,
 * and an array consumer then failed on `.map`. Keeping the discriminator on this
 * separate params type means only the paged reader ({@link DocumentListPage}
 * hook) can request the envelope shape; the bare-array hook cannot select it by
 * accident.
 *
 * Additive and opt-in on the wire: omitting `includeTotal` keeps the
 * long-standing bare-array response every other consumer (Documents index,
 * pickers, MCP, version-skewed API clients) already reads.
 */
export type DocumentListPageParams = FindDocumentsOptions & {
  includeTotal: true;
};

/**
 * Client-supplied repository selection used to build the document's
 * `repositorySnapshot` at creation time (PLN-602). When present, the server
 * assembles a `loop_selection` snapshot from this input. When absent the
 * snapshot falls through to project defaults. Branch/ref are optional —
 * projects do not pin branches by default.
 */
export type RepositorySelectionInput = {
  primary: { fullName: string; branch?: string | null };
  additional?: Array<{ fullName: string; branch?: string | null }>;
};

export type CreateDocumentInput = {
  /**
   * Owning project. Optional for org-level artifacts — a generic Document
   * (DOC) or a Template — which carry no project (FEA-1749/FEA-4345). Required
   * for project-bound subtypes (PRD/IMPLEMENTATION_PLAN/FEATURE). Because this
   * shared type serves both org-level and project-bound creates it is typed
   * optional; the "required for project-bound types" rule is enforced at
   * runtime by BOTH the create validator refine AND the service-layer guard in
   * `createDocumentRecord` (via {@link isProjectOptionalDocumentType}), so a
   * direct service caller cannot bypass the check the validator would apply on
   * the HTTP path.
   */
  projectId?: string;
  sourceId?: string;
  /**
   * Accepted request-side document type: the persisted {@link DocumentType}
   * superset plus the `ISSUE` alias ({@link DocumentTypeInput}, ISS-4397). A
   * typed caller (e.g. `useCreateDocument`) may pass `ISSUE` or `FEATURE`; both
   * create FEATURE-typed artifacts. Normalized to a persisted
   * {@link DocumentType} at the API/MCP boundary ({@link normalizeDocumentType}) —
   * and defensively re-normalized in `createDocumentRecord` for the in-code
   * service callers — so the alias never persists as `Artifact.subtype`.
   */
  type: DocumentTypeInput;
  title: string;
  fileName?: string;
  approverId?: string | null;
  status?: ArtifactStatus;
  priority?: Priority;
  dueDate?: Date | null;
  content: string;
  assigneeId?: string | null;
  templateForType?: DocumentType | null;
  /**
   * Explicit per-document repository selection (e.g. the user picked these in
   * the Create-Document modal). Accepted by the client validator; the server
   * builds a `loop_selection` snapshot from it. See PLN-602.
   */
  repositorySelection?: RepositorySelectionInput;
};

export const MAX_CREATE_DOCUMENT_INLINE_IMAGES =
  SHARED_MAX_DOCUMENT_INLINE_IMAGES;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS =
  SHARED_MAX_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES =
  SHARED_MAX_DOCUMENT_INLINE_REQUEST_BODY_BYTES;

/**
 * Page size the My Tasks board requests from GET /documents (FEA-4373). The
 * board renders one row/card per assigned artifact, so a very large set could
 * crash it; it passes this as an explicit `limit` to bound its own fetch. It is
 * NOT a server default — the endpoint stays unbounded when `limit` is omitted so
 * other consumers (Documents index, pickers, API clients) are unaffected. Sized
 * well above a typical task queue; mirrors the Branches list bound
 * (`BRANCH_LIST_DEFAULT_LIMIT`).
 */
export const DOCUMENT_LIST_DEFAULT_LIMIT = 200;
/**
 * Hard ceiling on GET /documents result size (FEA-4373). A caller-supplied
 * `limit` is clamped to this; the fetch can never exceed it in one page.
 */
export const DOCUMENT_LIST_MAX_LIMIT = 500;
/** Upper bound on the accepted `offset` (FEA-4373), matching the Branches list. */
export const DOCUMENT_LIST_MAX_OFFSET = 10_000;
/**
 * The recency window, in days, that the My Tasks board REQUESTS once its
 * `my-tasks-recency-window` flag is on (FEA-1626, parent epic FEA-908). The
 * server imposes no window of its own — see
 * {@link FindDocumentsOptions.recencyDays} for why omission has to keep meaning
 * "full history" across a deploy boundary — so this is a client-side default
 * carried here because the label the board renders ("Last 90 days") and the day
 * count it sends must come from ONE number.
 *
 * A power user's assigned history spans years; drawing all of it on first paint
 * is the root of the projected 30–60s foundational-page load. Ninety days is
 * chosen against the acceptance criterion: a ~12-month account must come back
 * BOUNDED, so the window has to be materially shorter than a year. It applies to
 * `Artifact.updatedAt`, not `createdAt`, so an old artifact that is still being
 * worked stays in the window.
 */
export const DOCUMENT_LIST_DEFAULT_RECENCY_DAYS = 90;
/** Floor on an explicitly requested recency window (FEA-1626). */
export const DOCUMENT_LIST_MIN_RECENCY_DAYS = 1;
/**
 * Ceiling on an explicitly requested recency window (FEA-1626), ~10 years. A
 * caller that wants genuinely everything passes {@link DocumentListRecency.All}
 * rather than an ever-larger number.
 */
export const DOCUMENT_LIST_MAX_RECENCY_DAYS = 3650;
/**
 * Sentinel for "no recency window at all" on GET /documents (FEA-1626). Sent as
 * the literal string `all`, so it is unambiguous against the numeric day counts
 * on a query string. This is how a caller explicitly asks for older data.
 */
export const DocumentListRecency = { All: "all" } as const;
export type DocumentListRecency =
  (typeof DocumentListRecency)[keyof typeof DocumentListRecency];
/** Accepted `recencyDays` values: a day count, or the "all" opt-out. */
export type DocumentListRecencyDays = number | DocumentListRecency;

export const CreateDocumentErrorCode = {
  DocumentCreateFailed: "document_create_failed",
  DuplicateInlineImagePlaceholder: "duplicate_inline_image_placeholder",
  ExpandedContentTooLarge: "expanded_inline_image_content_too_large",
  InlineImageCreationFailed: "inline_image_creation_failed",
  MissingInlineImagePlaceholder: "missing_inline_image_placeholder",
  OverlappingInlineImagePlaceholder: "overlapping_inline_image_placeholder",
  RequestBodyTooLarge: "create_document_inline_images_request_too_large",
  VersionContentUpdateFailed: "document_initial_version_update_failed",
} as const;
export type CreateDocumentErrorCode =
  (typeof CreateDocumentErrorCode)[keyof typeof CreateDocumentErrorCode];

export type CreateDocumentInlineImageInput =
  CreateDocumentVersionInlineImageInput;
export type CreatedDocumentInlineImage = Pick<
  CreatedDocumentVersionInlineImage,
  "attachmentId" | "attachmentRef" | "markdownImage" | "placeholder"
>;

export type CreateDocumentRequestBody = CreateDocumentInput & {
  inlineImages?: CreateDocumentInlineImageInput[];
};

export type CreateDocumentResponse = Document & {
  inlineImages?: CreatedDocumentInlineImage[];
  versionContent?: string;
};

export type UpdateDocumentInput = {
  id: string;
  title?: string;
  fileName?: string;
  projectId?: string;
  approverId?: string | null;
  status?: ArtifactStatus;
  priority?: Priority;
  dueDate?: Date | null;
  assigneeId?: string | null;
  sortOrder?: number | null;
};

export type MergeDocumentsInput = {
  primaryDocumentId: string;
  secondaryDocumentId: string;
};

/** Branch artifact summary returned by document and loop projections. */
export type BranchInfo = {
  id: string;
  name: string;
  htmlUrl: string | null;
  branchName: string;
  baseBranch: string | null;
  headSha: string | null;
  checksStatus: ChecksStatus | null;
  externalLinkId: string | null;
  repoFullName: string | null;
  currentPullRequest: PullRequestInfo | null;
};

export function pickBranchForRepo(
  branches: BranchInfo[] | null | undefined,
  repoFullName: string | null | undefined
): BranchInfo | null {
  if (!branches || branches.length === 0) {
    return null;
  }
  return (
    (repoFullName
      ? branches.find((branch) => branch.repoFullName === repoFullName)
      : undefined) ??
    branches[0] ??
    null
  );
}

export function pickPullRequestForRepo(
  pullRequests: PullRequestInfo[] | null | undefined,
  repoFullName: string | null | undefined
): PullRequestInfo | null {
  if (!pullRequests || pullRequests.length === 0) {
    return null;
  }
  return (
    (repoFullName
      ? pullRequests.find((pr) => pr.repoFullName === repoFullName)
      : undefined) ??
    pullRequests[0] ??
    null
  );
}

// Generation status for documents being processed by a Loop
export type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  command:
    | "plan"
    | "execute"
    | "chat"
    | "request_changes"
    | "request_prd_changes"
    | "generate_prd"
    | "explore"
    | "decompose"
    | "evaluate_prd"
    | "evaluate_plan"
    | "evaluate_code"
    | "evaluate_feature"
    | null;
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
  /** Identifies the compute backend that produced this status. */
  source?: "loop";
  /** Loop ID when source is "loop". Used for internal navigation to /loops/:id. */
  loopId?: string | null;
  /**
   * The SESSION-typed Artifact that materializes this run in the unified
   * Sessions list (FEA-1718; `Loop.sessionArtifactId`, unique -> at most one per
   * loop). Lets a surface link the operator to the work in progress without
   * reintroducing a Loop as a user-facing concept.
   *
   * OMITTED, never null, when the loop has not materialized a Session yet: it is
   * written after the run starts, so an active generation legitimately has none
   * for the first moments. A consumer must render the in-progress state without
   * a link rather than emit one that goes nowhere.
   *
   * NOT a reversal of `toLoop`, which strips the same column from the Loop
   * contract (`apps/api/app/loops/service.ts`, pinned by a regression test at
   * `apps/api/app/loops/__tests__/service.test.ts`). That contract publishes a
   * LOOP, where the column is an internal materialization FK and exposing it
   * would make the Loop's own linkage table part of its public shape. This
   * contract publishes a document's RUN STATE, whose whole job is to point the
   * operator at the work; the id is the only thing on either record that can do
   * that, and it is published here as a SESSION artifact id — the same
   * user-facing identifier `/{orgSlug}/sessions/{id}` already routes on — not as
   * Loop linkage. Keep `toLoop` stripping it.
   */
  sessionArtifactId?: string;
  /** User who initiated the generation loop. */
  initiatedBy?: {
    firstName: string | null;
    lastName: string | null;
  } | null;
  /**
   * Server-computed stable identifier for a specific generation run.
   * Used for status dismissal and cross-client synchronization.
   */
  runKey?: string | null;
};

const ACTIVE_GENERATION_STATUSES = ["PENDING", "QUEUED", "RUNNING"] as const;

export function isActiveGenerationStatus(
  status: GenerationStatus["status"]
): boolean {
  return ACTIVE_GENERATION_STATUSES.includes(
    status as (typeof ACTIVE_GENERATION_STATUSES)[number]
  );
}

/**
 * Build a stable run key for generation status identity.
 * Preference order: loopId, correlationId, startedAt, completedAt.
 */
export function getGenerationStatusRunKey(
  generationStatus: Pick<
    GenerationStatus,
    "loopId" | "correlationId" | "startedAt" | "completedAt"
  >
): string | null {
  if (generationStatus.loopId) {
    return `loop:${generationStatus.loopId}`;
  }
  if (generationStatus.correlationId) {
    return `corr:${generationStatus.correlationId}`;
  }
  if (generationStatus.startedAt) {
    return `started:${generationStatus.startedAt.toISOString()}`;
  }
  if (generationStatus.completedAt) {
    return `completed:${generationStatus.completedAt.toISOString()}`;
  }
  return null;
}

// Plan JSON types for code plugin artifacts
export type PlanAcceptanceCriterion = {
  id: string;
  criterion: string;
  source: string;
};

export type PlanTask = {
  id: string;
  description: string;
  acceptanceCriteria: string[];
};

export type PlanOpenQuestion = {
  id: string;
  question: string;
  recommendedAnswer?: string | null;
  blockingTask?: string | null;
};

export type PlanAnsweredQuestion = {
  id: string;
  question: string;
  answer: string;
};

export type PlanGap = {
  id: string;
  description: string;
  addressed: boolean;
  resolution?: string | null;
};

export type PlanJson = {
  content: string;
  acceptanceCriteria: PlanAcceptanceCriterion[];
  pendingTasks: PlanTask[];
  completedTasks: PlanTask[];
  openQuestions: PlanOpenQuestion[];
  answeredQuestions: PlanAnsweredQuestion[];
  gaps: PlanGap[];
  manualTasks?: PlanTask[];
};

/**
 * Metadata entry for a single document returned by the batch-meta endpoint.
 * `type` is optional because documents with an unrecognized subtype still
 * appear in the map (with name enrichment) but without a navigable type.
 */
export type DocumentMeta = {
  title: string;
  type?: DocumentType;
};

/**
 * Map of document slug to document metadata (title and type).
 * Returned by the batch-meta endpoint for lightweight name lookups.
 * Slugs not found in the org are omitted.
 */
export type DocumentMetaMap = Record<string, DocumentMeta>;

/** Maximum number of slugs accepted by GET /documents/batch-meta */
export const BATCH_META_MAX_SLUGS = 50;

/**
 * Build a document URL path, optionally scoped by org slug.
 * Callers are responsible for null-checking the route prefix before calling.
 */
export function buildScopedDocumentPath(
  routePrefix: string,
  slug: string,
  orgSlug?: string | null
): string {
  return orgSlug
    ? `/${orgSlug}/${routePrefix}/${slug}`
    : `/${routePrefix}/${slug}`;
}

/**
 * Document subtypes that are org-level and may be created without a project
 * (FEA-1749/FEA-4345): a generic Document (DOC) and a Template. Every other
 * subtype (PRD/IMPLEMENTATION_PLAN/FEATURE) is project-bound and requires a
 * `projectId`. Canonical SSOT for "does a create of this type need a project?"
 * — consumed by the create validator refine (`apps/api/.../validators.ts`) AND
 * the service-layer create guard (`createDocumentRecord`) so a direct service
 * caller cannot bypass the check the way it could when the two lists drifted.
 */
export const PROJECT_OPTIONAL_DOCUMENT_TYPES: ReadonlySet<DocumentType> =
  new Set<DocumentType>([DocumentType.Doc, DocumentType.Template]);

/**
 * True when a create of `type` is allowed to omit `projectId` (org-level
 * artifact). Project-bound subtypes (PRD/IMPLEMENTATION_PLAN/FEATURE) return
 * false and must carry a `projectId`. `CreateDocumentInput.projectId` is typed
 * optional to model the org-level case; this predicate is the runtime gate that
 * keeps a project-bound create from silently persisting a project-less row.
 */
export function isProjectOptionalDocumentType(type: DocumentType): boolean {
  return PROJECT_OPTIONAL_DOCUMENT_TYPES.has(type);
}

/**
 * ISS-4397: the single public-contract schema for a document-type *input* at the
 * API/MCP boundary. Accepts the accepted-input superset (every canonical
 * {@link DocumentType} plus the `ISSUE` alias) and normalizes it to the persisted
 * `DocumentType` — `ISSUE`→`FEATURE`, every other value maps to itself — so the
 * alias never leaks past the boundary into the service/Prisma layer.
 *
 * Exported from the same module as the type it validates (per
 * `packages/api/AGENTS.md`) so the create-document body validator, the
 * findDocuments query validator, and the MCP `list-documents` tool all reuse one
 * schema instead of re-declaring `z.enum(DocumentTypeInput).transform(...)`.
 */
export const documentTypeInputSchema = z
  .enum(DocumentTypeInput)
  .transform(normalizeDocumentType);

/**
 * Paged response envelope for `GET /documents?includeTotal=true` (ISS-4576).
 *
 * The bare-array response is still the default; a caller that pages opts into
 * this shape because a page alone cannot answer "how many are there?". Every
 * field describes the page the server actually served, so a client never has to
 * infer a total from `items.length` — the FEA-4373 bounded read made that
 * inference a lie the moment the assigned set exceeded the page.
 */
export type DocumentListPage = {
  /** The requested page, in the same order the bare-array response returns. */
  items: DocumentWithProject[];
  /**
   * REAL count of every artifact matching the query's predicate, counted
   * server-side independently of `limit`/`offset`. Never derived from `items`.
   */
  total: number;
  /**
   * Effective page size the server applied after clamping, or `null` when the
   * caller requested no bound (the whole matching set is in `items`).
   */
  limit: number | null;
  /** Effective zero-based offset the server applied after clamping. */
  offset: number;
  /** True when rows matching the predicate exist beyond this page. */
  hasMore: boolean;
};

/**
 * Structural validator for the {@link DocumentListPage} envelope (ISS-4576).
 *
 * Only the envelope's OWN fields are validated here — `items` is passed through
 * as the document array the bare-array reader already returns and consumers
 * already handle, so this does not re-validate every `DocumentWithProject` field
 * (that shape has no schema and building one is out of scope). The point of this
 * schema is to tell an envelope from a bare array at the network boundary, which
 * `normalizeDocumentListResponse` needs to survive version skew.
 */
export const documentListPageSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number(),
  limit: z.number().nullable(),
  offset: z.number(),
  hasMore: z.boolean(),
});

/**
 * Normalize a `GET /documents?includeTotal=true` response into a
 * {@link DocumentListPage}, surviving version skew (ISS-4576, shafty023 review).
 *
 * An OLDER API that predates `includeTotal` strips the unknown query param and
 * returns the legacy bare `DocumentWithProject[]` — it also ignored the `limit`,
 * so the array is the WHOLE matching set. Without this normalization a paging
 * client read that array as an envelope, found no `.items`/`.total`, and
 * rendered an empty queue (the My Tasks board showed nothing). Here a bare array
 * degrades gracefully to the honest "everything on one unbounded page": `items`
 * is the array, `total` its length (the count the server would have returned),
 * `limit` null (no bound was applied), `hasMore` false (there is no next page).
 *
 * A well-formed envelope from a current server passes through unchanged. Any
 * other shape (a malformed body) yields a safe empty page rather than throwing,
 * so a bad response degrades to an empty board instead of crashing the render.
 */
export function normalizeDocumentListResponse(
  response: unknown
): DocumentListPage {
  if (Array.isArray(response)) {
    const items = response as DocumentWithProject[];
    return {
      items,
      total: items.length,
      limit: null,
      offset: 0,
      hasMore: false,
    };
  }
  const parsed = documentListPageSchema.safeParse(response);
  if (parsed.success) {
    return {
      items: parsed.data.items as DocumentWithProject[],
      total: parsed.data.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      hasMore: parsed.data.hasMore,
    };
  }
  return { items: [], total: 0, limit: null, offset: 0, hasMore: false };
}
