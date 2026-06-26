import {
  DOCUMENT_STATUS_OPTIONS as SHARED_DOCUMENT_STATUS_OPTIONS,
  DOCUMENT_TYPE_OPTIONS as SHARED_DOCUMENT_TYPE_OPTIONS,
  ChecksStatus as SharedChecksStatus,
  DocumentStatus as SharedDocumentStatus,
  DocumentType as SharedDocumentType,
  PullRequestState as SharedPullRequestState,
  RepositoryRole as SharedRepositoryRole,
  ReviewDecision as SharedReviewDecision,
  SnapshotSource as SharedSnapshotSource,
  artifactRepositoryEntrySchema as sharedArtifactRepositoryEntrySchema,
  artifactRepositorySnapshotSchema as sharedArtifactRepositorySnapshotSchema,
} from "@closedloop-ai/loops-api/document";
import type { z } from "zod";
import type { Priority } from "./common.js";
import type { CustomFieldValueDetail } from "./custom-field.js";
import type { DocumentVersion } from "./document-version.js";
import type { TagSummary } from "./tag.js";
import type { BasicUser } from "./user.js";

export const artifactRepositoryEntrySchema =
  sharedArtifactRepositoryEntrySchema;
export const artifactRepositorySnapshotSchema =
  sharedArtifactRepositorySnapshotSchema;
export const ChecksStatus = SharedChecksStatus;
export const DocumentStatus = SharedDocumentStatus;
export const DOCUMENT_STATUS_OPTIONS = SHARED_DOCUMENT_STATUS_OPTIONS;
export const DocumentType = SharedDocumentType;
export const DOCUMENT_TYPE_OPTIONS = SHARED_DOCUMENT_TYPE_OPTIONS;
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

/**
 * Terminal document lifecycle statuses: the document is finished and will not
 * progress further. Canonical definition for "is this artifact resolved?"
 * checks (e.g. dependency/blocker gating).
 */
export const TERMINAL_DOCUMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  DocumentStatus.Done,
  DocumentStatus.Obsolete,
]);

/** Whether a document/artifact status string is a terminal lifecycle state. */
export function isTerminalDocumentStatus(status: string): boolean {
  return TERMINAL_DOCUMENT_STATUSES.has(status);
}
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];
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
  PRD: "prds",
  IMPLEMENTATION_PLAN: "implementation-plans",
  FEATURE: "features",
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
  status: DocumentStatus;
  priority: Priority;
  latestVersion: number;
  createdById: string;
  /** Original artifact creator summary. Null when the creator record is unavailable. */
  createdBy?: BasicUser | null;
  assigneeId: string | null;
  assignee: BasicUser | null;
  approverId: string | null;
  approver: BasicUser | null;
  tokenUsage: unknown;
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
  type?: DocumentType;
  projectId?: string;
  assigneeId?: string;
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
  projectId: string;
  sourceId?: string;
  type: DocumentType;
  title: string;
  fileName?: string;
  approverId?: string | null;
  status?: DocumentStatus;
  priority?: Priority;
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

export type UpdateDocumentInput = {
  id: string;
  title?: string;
  fileName?: string;
  projectId?: string;
  approverId?: string | null;
  status?: DocumentStatus;
  priority?: Priority;
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
