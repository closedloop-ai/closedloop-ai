// Document and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { Priority } from "./common";
import type { CustomFieldValueDetail } from "./custom-field";
import type { DocumentVersion } from "./document-version";
import type { BasicUser } from "./user";
import type { WorkstreamState } from "./workstream";

export const DocumentType = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
  Feature: "FEATURE",
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];
export const DOCUMENT_TYPE_OPTIONS = Object.values(DocumentType);

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

// Document Status
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

export type Document = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string | null;
  type: DocumentType;
  title: string;
  slug: string;
  fileName: string | null;
  status: DocumentStatus;
  priority: Priority;
  latestVersion: number;
  createdById: string;
  assigneeId: string | null;
  assignee: BasicUser | null;
  approverId: string | null;
  approver: BasicUser | null;
  tokenUsage: unknown;
  targetRepo: string | null;
  targetBranch: string | null;
  templateForType: DocumentType | null;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentWithWorkstream = Document & {
  workstream?: {
    id: string;
    title: string;
    state: WorkstreamState;
  } | null;
  project?: {
    id: string;
    name: string;
    teams?: { id: string; name: string }[];
  } | null;
  /** The latest generation status for this document. Omitted when no generation status is available. */
  generationStatus?: GenerationStatus;
  /** Custom field values attached to this document. Omitted when not requested. */
  customFields?: CustomFieldValueDetail[];
};

/** Detail response from GET /documents/:id and GET /documents/by-slug/:slug. Always includes version content. */
export type DocumentDetail = DocumentWithWorkstream & {
  version: DocumentVersion;
};

export type FindDocumentsOptions = {
  type?: DocumentType;
  workstreamId?: string;
  projectId?: string;
  assigneeId?: string;
};

export type CreateDocumentInput = {
  workstreamId?: string;
  projectId: string;
  sourceId?: string;
  type: DocumentType;
  title: string;
  fileName?: string;
  approverId?: string | null;
  status?: DocumentStatus;
  priority?: Priority;
  content: string;
  targetRepo?: string;
  targetBranch?: string;
  assigneeId?: string | null;
  templateForType?: DocumentType | null;
};

export type UpdateDocumentInput = {
  id: string;
  title?: string;
  fileName?: string;
  projectId?: string;
  approverId?: string | null;
  status?: DocumentStatus;
  priority?: Priority;
  targetRepo?: string | null;
  targetBranch?: string | null;
  assigneeId?: string | null;
  sortOrder?: number | null;
};

export type MergeDocumentsInput = {
  primaryDocumentId: string;
  secondaryDocumentId: string;
};

// Pull Request State
export const PullRequestState = {
  Open: "OPEN",
  Merged: "MERGED",
  Closed: "CLOSED",
} as const;
export type PullRequestState =
  (typeof PullRequestState)[keyof typeof PullRequestState];

// Review Decision
export const ReviewDecision = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Commented: "COMMENTED",
  Dismissed: "DISMISSED",
} as const;
export type ReviewDecision =
  (typeof ReviewDecision)[keyof typeof ReviewDecision];

// Pull Request info returned when an implementation plan is executed
export type PullRequestInfo = {
  id: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: PullRequestState;
  headBranch: string;
  baseBranch: string;
  createdAt: Date;
  checksStatus: ChecksStatus | null;
  reviewDecision: ReviewDecision | null;
  externalLinkId: string | null;
  repoFullName: string | null;
};

export function pickPullRequestForRepo(
  pullRequests: PullRequestInfo[],
  repoFullName: string | null | undefined
): PullRequestInfo | null {
  return (
    (repoFullName
      ? pullRequests.find((pr) => pr.repoFullName === repoFullName)
      : undefined) ??
    pullRequests[0] ??
    null
  );
}

// Generation status for documents being processed by GitHub Actions or Loops
export type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  command:
    | "plan"
    | "execute"
    | "chat"
    | "request_changes"
    | "request_prd_changes"
    | "explore"
    | "decompose"
    | "evaluate_prd"
    | null;
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
  /** Identifies the compute backend that produced this status. */
  source?: "github_actions" | "loop";
  /** Loop ID when source is "loop". Used for internal navigation to /loops/:id. */
  loopId?: string | null;
  /** User who initiated the generation (loop or workflow). */
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

export type BatchCreateDocumentInput = {
  items: CreateDocumentInput[];
};

/**
 * Map of document slug to document title.
 * Returned by the batch-meta endpoint for lightweight name lookups.
 * Slugs not found in the org are omitted.
 */
export type DocumentTitleMap = Record<string, string>;

/** Maximum number of slugs accepted by GET /documents/batch-meta */
export const BATCH_META_MAX_SLUGS = 50;
