import {
  DOCUMENT_STATUS_OPTIONS as SHARED_DOCUMENT_STATUS_OPTIONS,
  DOCUMENT_TYPE_INPUT_OPTIONS as SHARED_DOCUMENT_TYPE_INPUT_OPTIONS,
  DOCUMENT_TYPE_OPTIONS as SHARED_DOCUMENT_TYPE_OPTIONS,
  ISSUE_STATUS_OPTIONS as SHARED_ISSUE_STATUS_OPTIONS,
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
  isPrimaryRepoObserved as sharedIsPrimaryRepoObserved,
  isSnapshotCorrectable as sharedIsSnapshotCorrectable,
  isTerminalStatusForSubtype as sharedIsTerminalStatusForSubtype,
  normalizeDocumentType as sharedNormalizeDocumentType,
  snapshotSourceSchema as sharedSnapshotSourceSchema,
  statusOptionsForSubtype as sharedStatusOptionsForSubtype,
} from "@closedloop-ai/loops-api/document";
import { z } from "zod";
import type { ArtifactStatusEditSurface } from "./artifact-status-contract.js";
import type { BranchProductEligibility } from "./branch-product-eligibility.ts";
import type { Priority } from "./common.js";
import {
  CreateDocumentErrorCode as sharedCreateDocumentErrorCode,
  MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS as sharedMaxCreateDocumentInlineExpandedContentChars,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS as sharedMaxCreateDocumentInlineImageAltTextChars,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS as sharedMaxCreateDocumentInlineImageFilenameChars,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS as sharedMaxCreateDocumentInlineImagePlaceholderChars,
  MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES as sharedMaxCreateDocumentInlineImageRequestBodyBytes,
  MAX_CREATE_DOCUMENT_INLINE_IMAGES as sharedMaxCreateDocumentInlineImages,
  SourceLinkedPlanCreateErrorCode as sharedSourceLinkedPlanCreateErrorCode,
  SourceLinkedPlanOutcome as sharedSourceLinkedPlanOutcome,
  SourceLinkedPlanPolicy as sharedSourceLinkedPlanPolicy,
  sourceLinkedPlanPolicySchema as sharedSourceLinkedPlanPolicySchema,
} from "./create-document.ts";
import type { CustomFieldValueDetail } from "./custom-field.js";
import type { DocumentStatusMutationCapability } from "./document-status-mutation.ts";
import type { DocumentVersion } from "./document-version.js";
import { TABLE_PAGE_SIZE_MAX } from "./table-page-size-limits.ts";
import type { TagSummary } from "./tag.js";
import type { ProjectTeamOption } from "./teams.js";
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
export const snapshotSourceSchema = sharedSnapshotSourceSchema;
export const isPrimaryRepoObserved = sharedIsPrimaryRepoObserved;
export const isSnapshotCorrectable = sharedIsSnapshotCorrectable;

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

export type {
  CreateDocumentInlineImageInput,
  CreateDocumentInput,
  CreateDocumentRequestBody,
  CreateDocumentResponse,
  CreatedDocumentInlineImage,
  RepositorySelectionInput,
  SourceLinkedPlanAmbiguousPlan,
  SourceLinkedPlanAmbiguousResponse,
  SourceLinkedPlanResult,
} from "./create-document.ts";

export const CreateDocumentErrorCode = sharedCreateDocumentErrorCode;
export const MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS =
  sharedMaxCreateDocumentInlineExpandedContentChars;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_ALT_TEXT_CHARS =
  sharedMaxCreateDocumentInlineImageAltTextChars;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_FILENAME_CHARS =
  sharedMaxCreateDocumentInlineImageFilenameChars;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_PLACEHOLDER_CHARS =
  sharedMaxCreateDocumentInlineImagePlaceholderChars;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGE_REQUEST_BODY_BYTES =
  sharedMaxCreateDocumentInlineImageRequestBodyBytes;
export const MAX_CREATE_DOCUMENT_INLINE_IMAGES =
  sharedMaxCreateDocumentInlineImages;
export const SourceLinkedPlanCreateErrorCode =
  sharedSourceLinkedPlanCreateErrorCode;
export const SourceLinkedPlanOutcome = sharedSourceLinkedPlanOutcome;
export const SourceLinkedPlanPolicy = sharedSourceLinkedPlanPolicy;
export const sourceLinkedPlanPolicySchema = sharedSourceLinkedPlanPolicySchema;

export type CreateDocumentErrorCode =
  (typeof CreateDocumentErrorCode)[keyof typeof CreateDocumentErrorCode];
export type SourceLinkedPlanCreateErrorCode =
  (typeof SourceLinkedPlanCreateErrorCode)[keyof typeof SourceLinkedPlanCreateErrorCode];
export type SourceLinkedPlanOutcome =
  (typeof SourceLinkedPlanOutcome)[keyof typeof SourceLinkedPlanOutcome];
export type SourceLinkedPlanPolicy =
  (typeof SourceLinkedPlanPolicy)[keyof typeof SourceLinkedPlanPolicy];

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
  /** Eligibility inherited from the owning Branch Artifact when projected. */
  productEligibility?: BranchProductEligibility;
  /** True only when the API verified a provider PR compatibility fallback. */
  hasCompatibilityProviderFallback?: boolean;
};

export const DOCUMENT_ROUTE_PREFIX = "documents";
export const ISSUES_LIST_ROUTE_SEGMENT = "issues";
export const RETIRED_ISSUES_ROUTE_SEGMENT = "features";

/**
 * Maps document types to their detail route prefix. Every navigable document
 * opens at `/documents/:slug` (ISS-12855, PRD-799 G-01); Template has no detail
 * route.
 */
export const TYPE_ROUTE_PREFIX: Partial<Record<DocumentType, string>> = {
  [DocumentType.Prd]: DOCUMENT_ROUTE_PREFIX,
  [DocumentType.ImplementationPlan]: DOCUMENT_ROUTE_PREFIX,
  [DocumentType.Feature]: DOCUMENT_ROUTE_PREFIX,
  [DocumentType.Doc]: DOCUMENT_ROUTE_PREFIX,
};

/**
 * Retired detail-route prefixes per document type. Redirected by
 * `apps/app/lib/legacy-document-route-redirects.ts`, parsed by
 * `packages/github/artifact-reference-parser.ts`, and still matched by the
 * Desktop route table. `issues` is also the live Issues LIST segment. Removing
 * an entry needs human approval.
 */
export const LEGACY_TYPE_ROUTE_PREFIXES: Partial<
  Record<DocumentType, readonly string[]>
> = {
  [DocumentType.Prd]: ["prds"],
  [DocumentType.ImplementationPlan]: ["implementation-plans"],
  [DocumentType.Feature]: [
    ISSUES_LIST_ROUTE_SEGMENT,
    RETIRED_ISSUES_ROUTE_SEGMENT,
  ],
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
 *
 * A returned entry is NOT necessarily a measured fact: rows created before
 * ISS-8164 — and any row whose artifact never got a branch link — can carry a
 * project-level default that names a repository the work never touched. Those
 * rows are disclosed, not repaired, so a repo-scoped rollup or blast-radius
 * query must filter on {@link isPrimaryRepoObserved} rather than trusting this
 * `fullName`.
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
  /**
   * ISS-9665: `null` means the artifact has NO priority — a real state, not a
   * missing read. `Artifact.priority` has been nullable since the artifact-parent
   * refactor, but `toDocument` used to fold `null` into `MEDIUM`, so one artifact
   * serialized `MEDIUM` here and `null` on `/search`, `/artifact-links/resolved`,
   * and the project tree. `null` is emitted rather than the key omitted because
   * this is a REQUIRED response field older clients already read positionally;
   * dropping it would make "unset" indistinguishable from "this build is too old
   * to send a priority".
   */
  priority: Priority | null;
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
   * Server-owned per-document record of the repositories this artifact belongs
   * to. Populated at creation and never editable through
   * `PATCH /documents/:id`; the one post-create writer is the ISS-8164
   * reconcile, which replaces a never-observed snapshot with the repository a
   * linked branch resolves. Always present post-backfill (PLN-602) — documents
   * without any resolved repos carry `source: 'none'` with an empty
   * `repositories` array. Read {@link isPrimaryRepoObserved} before treating a
   * `fullName` here as a measured fact.
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
    teams?: ProjectTeamOption[];
  } | null;
  /** Server-computed status-write contract for this document's subtype. Omitted by older API deploys during version skew. */
  statusMutation?: DocumentStatusMutationCapability;
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
  /** Exact complete cohort; summary readers bound IDs per request. */
  artifactIds?: string[];
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
  /** Optional union of artifact subtypes; repeated `types` query parameters. */
  types?: readonly DocumentTypeInput[];
  projectId?: string;
  assigneeId?: string;
  /**
   * When true, return only project-less (org-level / evergreen) documents —
   * those with `projectId === null`. Kept for API callers; the org Documents
   * index stopped sending it in ISS-12858 (PRD-799 G-04: project membership
   * never removes a document from the global list).
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
   * (an offset into an unbounded result is meaningless). Floored at 0 and
   * otherwise uncapped since ISS-11161 — see {@link DOCUMENT_LIST_MAX_OFFSET}.
   */
  offset?: number;
  /**
   * Recency window in days, applied to `Artifact.updatedAt` (FEA-1626).
   *
   * **Omission means no window at all**, on every arm — the full-history
   * contract the Documents index, pickers, the MCP `list-documents` tool, and
   * version-skewed API-key clients depend on. Windowing is opt-IN: a client that
   * wants a bounded read names the day count. That polarity is deliberate and
   * deploy-order-driven (whitlockk review): `apps/app` and `apps/api` ship
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
  /**
   * Free-text narrowing on the artifact's own `title` and `slug`, executed in
   * the database over the WHOLE matching population rather than over a page a
   * client happens to hold (ISS-9724).
   *
   * **Matching is case-insensitive SUBSTRING, and that is a decision, not a
   * default.** It is the semantics the Documents index search box already has —
   * `matchesFilter` in `@repo/app/documents/lib/document-filter` is a
   * `toLowerCase().includes()` over exactly these two fields — so moving the
   * search server-side answers the same question the reader is already asking.
   * The repo's other matching semantics, the `search_document` FTS projection
   * behind `GET /search`, was considered and NOT reused here for two reasons.
   * (1) It is lexeme-based: it would stop matching the mid-word fragments a
   * substring box matches today (`"eploy"` finds `"deployment"`; a tsquery
   * cannot), so adopting it would silently change what this surface finds.
   * (2) It cannot compose into this list predicate without giving up the very
   * property the ticket is about — its candidate query is itself paged behind a
   * keyset cursor, so folding it in would mean either an unbounded id
   * materialization or a truncated id set, and a truncated id set IS a
   * page-scoped search wearing a server-side costume.
   * The `SEMANTICS_PROBES` cases in
   * `apps/api/app/documents/document-list-search.integration.test.ts` are what
   * stop the two predicates this surface now has — the client filter and this
   * one — from drifting apart: they ask both the same terms over one corpus and
   * require the same answer.
   *
   * Additive and opt-in: omission means no text narrowing at all, the
   * long-standing behavior every existing consumer (pickers, MCP,
   * version-skewed API clients) reads. A blank or whitespace-only value is
   * REJECTED at the boundary rather than treated as omission, so a search that
   * cannot narrow anything can never be silently dropped while the box claims
   * otherwise. Capped at {@link DOCUMENT_LIST_MAX_SEARCH_LENGTH} characters.
   */
  search?: string;
  /**
   * Lifecycle-status narrowing, applied as an `IN` predicate on
   * `Artifact.status` IN THE DATABASE rather than over rows a client already
   * holds (ISS-6778).
   *
   * **This is the whole ticket: without it the status question can only be
   * asked after the rows arrive, so the answer is bounded by the page rather
   * than by the population.** `symphony-nightly-apply` logged "no TODO issues to
   * sweep" on every run while 25 tagged TODOs waited, because the first 100 rows
   * of a 1,144-artifact project held none of them — they sat at positions
   * 158-394. The My Tasks board has the same defect today at a larger scale: an
   * operator with 1,093 assigned artifacts inside the 90-day window spends its
   * entire {@link DOCUMENT_LIST_MAX_LIMIT}-row budget on rows it is about to
   * discard, to surface the 48 that are `TODO`.
   *
   * **Values are matched literally against the stored column, and the requested
   * `type` does not restrict which are accepted.** `Artifact.status` is a
   * freeform String carrying two disjoint vocabularies selected by `subtype`
   * ({@link statusOptionsForSubtype}), and off-vocabulary rows demonstrably
   * exist — a FEATURE carrying the {@link DocumentStatus} member `OBSOLETE` is
   * the live example {@link fallbackStatusForSubtype} documents, and the API
   * still returns it raw. Refusing `type=FEATURE&status=OBSOLETE` would make
   * exactly those rows unreachable through the filter that exists to find them,
   * so a combination with no matching rows returns an empty page rather than a
   * 400. A value outside BOTH vocabularies is still rejected at the boundary, so
   * a typo stays loud.
   *
   * Additive and opt-in: omission means no status narrowing at all, the
   * long-standing behavior every existing consumer (Documents index, pickers,
   * MCP, version-skewed API clients) reads.
   */
  status?: readonly ArtifactStatus[];
};

/**
 * Filter set PLUS the response-shape discriminator for the paged read
 * (`GET /documents?includeTotal=true`, ISS-4576).
 *
 * `includeTotal` is deliberately NOT a member of {@link FindDocumentsOptions}
 * (davetho review): it selects the response ARM (envelope vs bare array), it is
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
 *
 * ISS-9724: DERIVED from {@link TABLE_PAGE_SIZE_MAX}, the largest rung the
 * shared rows-per-page ladder offers, rather than written out. It was a bare
 * `500` that happened to agree; the same coincidence in Sessions and Branches
 * is what ISS-9692 had to repair, because a ladder that grows past a
 * hand-written cap offers a page size the endpoint answers with a 400.
 * `apps/api/__tests__/unit/list-page-size-caps.test.ts` drives the real
 * validator at the ladder's largest rung, so the two cannot part again.
 */
export const DOCUMENT_LIST_MAX_LIMIT = TABLE_PAGE_SIZE_MAX;
/**
 * Longest accepted {@link FindDocumentsOptions.search} term (ISS-9724), bounding
 * the `ILIKE` pattern the predicate compiles to. Far past any real title or
 * slug, so it rejects only a term that was never going to match anything.
 *
 * The Branches list happens to bound its own `search` at the same number, but
 * this deliberately does NOT claim to be kept level with it: nothing enforces
 * that, and an unenforced "these stay in step" comment is the drift the sibling
 * {@link DOCUMENT_LIST_MAX_LIMIT} two lines up exists to demonstrate. Making the
 * two one declaration would mean reaching into the Branches contract, which this
 * ticket has no cause to touch.
 */
export const DOCUMENT_LIST_MAX_SEARCH_LENGTH = 200;
/**
 * The deepest `offset` EVERY deployed `GET /documents` accepts (FEA-4373).
 *
 * ISS-11161: the endpoint no longer rejects past it. A deep offset costs a scan
 * bounded by the matching population, which the endpoint's own unbounded arm
 * already reads in full, so the ceiling protected nothing, while refusing past
 * it pushed the MCP `list-documents` tool onto whole-corpus reads for every
 * deep page. An API older than that change still 400s past this value, so a
 * client that may meet one (the web pagers, the MCP tool's fallback) treats
 * this as the skew-safe ceiling.
 */
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

export type UpdateDocumentInput = {
  id: string;
  title?: string;
  fileName?: string;
  /**
   * `null` clears the project; omitting the key leaves it untouched
   * (ISS-12858, PRD-799 G-04).
   */
  projectId?: string | null;
  approverId?: string | null;
  status?: ArtifactStatus;
  /**
   * Which surface this write was made from, recorded on the activity receipt
   * (ISS-9436) and counted by the priority telemetry event (ISS-9443). One
   * field for the whole write, not one per field: the surface describes WHERE
   * the user acted, and a single PUT that moves a status and a priority moved
   * both from the same place.
   *
   * Omitted by a caller that cannot name one — an API-key write, an MCP agent,
   * a browser on an older build — and omission is preserved end to end, never
   * serialized as `null`.
   */
  surface?: ArtifactStatusEditSurface;
  /**
   * Optional stale-write guard. When present, the write is rejected with
   * `stale_status` unless the current persisted status still equals this value
   * or already equals `status` (ISS-9486 ruling 2: a retry never conflicts
   * with its own earlier success).
   */
  expectedStatus?: string;
  /**
   * ISS-9440: the priority half of the same guard. Rejected with
   * `stale_priority` unless the persisted priority still equals this value,
   * where `null` ASSERTS that the artifact holds no priority rather than
   * meaning "unguarded" — absence is spelled by omitting the key. A `priority`
   * the artifact already holds is never refused (ISS-9486).
   */
  expectedPriority?: Priority | null;
  /**
   * ISS-11198: the title and assignee halves of the same guard, each valid only
   * beside its own field and refused with `DocumentFieldMutationErrorCode`.
   * `expectedAssigneeId: null` ASSERTS the document has no assignee.
   */
  expectedTitle?: string;
  expectedAssigneeId?: string | null;
  /**
   * ISS-9665: `null` CLEARS the priority (the honest representation of "no
   * priority"); omitting the key leaves it untouched. The artifact column has
   * always accepted null — only the API validator refused it.
   */
  priority?: Priority | null;
  dueDate?: Date | null;
  assigneeId?: string | null;
  sortOrder?: number | null;
};

export type MergeDocumentsInput = {
  primaryDocumentId: string;
  secondaryDocumentId: string;
};

/** Branch artifact summary returned by document projections. */
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
  /** Additive Product-navigation decision; omission remains non-navigable. */
  productEligibility?: BranchProductEligibility;
  /** True only when the API verified a provider PR compatibility fallback. */
  hasCompatibilityProviderFallback?: boolean;
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
 * A DOC may also be created WITH a project (ISS-12858); only a TEMPLATE create
 * refuses one, in the create validator.
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
  /** Present when this server applied the additive union subtype filter. */
  appliedTypes?: DocumentType[];
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
  appliedTypes: z.array(documentTypeInputSchema).optional(),
  items: z.array(z.unknown()),
  total: z.number(),
  limit: z.number().nullable(),
  offset: z.number(),
  hasMore: z.boolean(),
});

/**
 * Normalize a `GET /documents?includeTotal=true` response into a
 * {@link DocumentListPage}, surviving version skew (ISS-4576, davetho review).
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
      ...(parsed.data.appliedTypes
        ? { appliedTypes: parsed.data.appliedTypes }
        : {}),
      items: parsed.data.items as DocumentWithProject[],
      total: parsed.data.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      hasMore: parsed.data.hasMore,
    };
  }
  return { items: [], total: 0, limit: null, offset: 0, hasMore: false };
}

/**
 * Continuation metadata for `GET /documents`, carried as RESPONSE HEADERS on
 * the bare-array arm (ISS-6941).
 *
 * WHY HEADERS, AND NOT A SECOND BODY SHAPE. The default response is a bare
 * `DocumentWithProject[]`, and every consumer that reads it — the Documents
 * index, the plan/document pickers, MCP, version-skewed API clients — indexes
 * and `.map`s it directly. There is nowhere in an array to put a sibling field,
 * and wrapping it is the breaking change {@link DocumentListPage} already exists
 * to avoid. A header is the one addition an existing client cannot notice: an
 * old caller ignores it, a new one reads it, and the parsed body is byte-for-byte
 * what it was.
 *
 * WHY IT IS NEEDED AT ALL WHEN THE ENVELOPE EXISTS. `includeTotal=true` has
 * answered this in the body since ISS-4576, but only for a caller who knows to
 * ask. A caller paging with `limit` + `offset` and nothing else — the shape the
 * ticket was filed against — receives a capped array and has no way to tell
 * "that was everything" from "the server capped me", because `limit` caps at
 * {@link DOCUMENT_LIST_MAX_LIMIT} and a full page is not evidence of either.
 * These headers are that answer, unconditional and un-asked-for.
 *
 * Lowercase names because that is how a `fetch` `Headers` lookup normalizes
 * them; the constant is what both sides read, so neither can invent a casing.
 */
export const DOCUMENT_LIST_CONTINUATION_HEADERS = {
  /** Real server-side count of every row matching the query's predicate. */
  Total: "x-document-list-total",
  /** `"true"` / `"false"` — whether rows exist beyond the page just served. */
  HasMore: "x-document-list-has-more",
  /**
   * The `offset` that reads the next page — this page's offset advanced past
   * the rows actually served, never past the `limit` the caller asked for: a
   * short final page would otherwise hand back an offset that skips rows.
   *
   * Present exactly when `HasMore` is `"true"`. A next-offset for a page that
   * does not exist is an invitation to fetch it, and a caller looping until an
   * empty response is exactly the caller this metadata exists to stop. Since
   * ISS-11161 the endpoint serves every offset, so the header is no longer
   * withheld past {@link DOCUMENT_LIST_MAX_OFFSET}.
   */
  NextOffset: "x-document-list-next-offset",
} as const;

/**
 * The facts {@link buildDocumentListContinuationHeaders} renders.
 *
 * Deliberately the same four fields {@link DocumentListPage} carries minus its
 * `items`, so the two arms of this endpoint state one thing in one vocabulary —
 * the envelope in its body, the bare array in its headers — rather than growing
 * a second, subtly different notion of "is there more".
 */
export type DocumentListContinuation = {
  total: number;
  offset: number;
  /** Rows in the response just served — what the next offset advances past. */
  pageCount: number;
  hasMore: boolean;
};

/**
 * Render {@link DocumentListContinuation} as the response headers above.
 *
 * Pure, and shared rather than inlined at the route, so a consumer's test can
 * build the exact header set the server sends instead of transcribing it.
 */
export function buildDocumentListContinuationHeaders(
  continuation: DocumentListContinuation
): Record<string, string> {
  const headers: Record<string, string> = {
    [DOCUMENT_LIST_CONTINUATION_HEADERS.Total]: String(continuation.total),
    [DOCUMENT_LIST_CONTINUATION_HEADERS.HasMore]: String(continuation.hasMore),
  };
  if (continuation.hasMore) {
    headers[DOCUMENT_LIST_CONTINUATION_HEADERS.NextOffset] = String(
      continuation.offset + continuation.pageCount
    );
  }
  return headers;
}
