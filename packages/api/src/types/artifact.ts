// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { ArtifactVersion } from "./artifact-version";
import type { CustomFieldValueDetail } from "./custom-field";
import type { EntityType } from "./entity-link";
import type { BasicUser } from "./user";
import type { WorkstreamState } from "./workstream";

/**
 * Artifact types in the new schema.
 * Only PRD, IMPLEMENTATION_PLAN, and TEMPLATE remain as artifact types.
 * Issues and external links (PR, Figma, etc.) are separate entities now.
 */
export const ArtifactType = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];
export const ARTIFACT_TYPE_OPTIONS = Object.values(ArtifactType);

/**
 * Maps artifact types to their URL route prefixes.
 * Single source of truth for type->route mapping used by:
 * - apps/app/lib/artifact-navigation.ts (frontend navigation)
 * - apps/app/app/(authenticated)/artifacts/[slug]/page.tsx (redirect fallback)
 * - packages/collaboration/room-metadata.ts (Liveblocks notification URLs)
 */
export const TYPE_ROUTE_PREFIX: Partial<Record<ArtifactType, string>> = {
  PRD: "prds",
  IMPLEMENTATION_PLAN: "implementation-plans",
};

/**
 * Returns the route prefix for a navigable artifact type, or null if not navigable.
 * Accepts raw strings (e.g. from Liveblocks room metadata) in addition to typed values.
 */
export function getRoutePrefixForType(type: string): string | null {
  if (type in TYPE_ROUTE_PREFIX) {
    return TYPE_ROUTE_PREFIX[type as ArtifactType] ?? null;
  }
  return null;
}

// Artifact Status
export const ArtifactStatus = {
  Draft: "DRAFT",
  InReview: "IN_REVIEW",
  Approved: "APPROVED",
  Obsolete: "OBSOLETE",
  ReadyForReview: "READY_FOR_REVIEW",
  Executed: "EXECUTED",
} as const;
export type ArtifactStatus =
  (typeof ArtifactStatus)[keyof typeof ArtifactStatus];
export const ARTIFACT_STATUS_OPTIONS = Object.values(ArtifactStatus);

export const ChecksStatus = {
  Unknown: "UNKNOWN",
  Pending: "PENDING",
  Passing: "PASSING",
  Failing: "FAILING",
} as const;
export type ChecksStatus = (typeof ChecksStatus)[keyof typeof ChecksStatus];

export type Artifact = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string | null;
  type: ArtifactType;
  title: string;
  slug: string;
  fileName: string | null;
  status: ArtifactStatus;
  latestVersion: number;
  createdById: string;
  assigneeId: string | null;
  assignee: BasicUser | null;
  approverId: string | null;
  approver: BasicUser | null;
  tokenUsage: unknown;
  targetRepo: string | null;
  targetBranch: string | null;
  templateForType: ArtifactType | null;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ArtifactWithWorkstream = Artifact & {
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
  /** The latest generation status for this artifact. Omitted when no generation status is available. */
  generationStatus?: GenerationStatus;
  /**
   * The pull request associated with this artifact's workstream.
   * - `undefined`: field was not populated (findById/findBySlug do not batch-fetch PR data)
   * - `null`: findAll ran and found no PR for this workstream
   * - `PullRequestInfo`: a PR was found and linked to this workstream
   */
  pullRequest?: PullRequestInfo | null;
  /** Plain-text snippet extracted from the latest version content. Omitted when no content exists. */
  snippet?: string | null;
  /** Custom field values attached to this artifact. Omitted when not requested. */
  customFields?: CustomFieldValueDetail[];
};

/** Detail response from GET /artifacts/:id and GET /artifacts/by-slug/:slug. Always includes version content. */
export type ArtifactDetail = ArtifactWithWorkstream & {
  version: ArtifactVersion;
};

export type FindArtifactsOptions = {
  type?: ArtifactType;
  workstreamId?: string;
  projectId?: string;
  assigneeId?: string;
};

export type CreateArtifactInput = {
  workstreamId?: string;
  projectId: string;
  sourceId?: string;
  sourceType?: EntityType;
  sourceVersion?: number;
  type: ArtifactType;
  title: string;
  fileName?: string;
  approverId?: string | null;
  status?: ArtifactStatus;
  content: string;
  targetRepo?: string;
  targetBranch?: string;
  assigneeId?: string | null;
  templateForType?: ArtifactType | null;
};

export type UpdateArtifactInput = {
  id: string;
  title?: string;
  fileName?: string;
  projectId?: string;
  approverId?: string | null;
  status?: ArtifactStatus;
  targetRepo?: string | null;
  targetBranch?: string | null;
  assigneeId?: string | null;
  sortOrder?: number | null;
};

export type MergeArtifactsInput = {
  primaryArtifactId: string;
  secondaryArtifactId: string;
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
};

// Generation status for artifacts being processed by GitHub Actions or Loops
export type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  command:
    | "plan"
    | "execute"
    | "chat"
    | "request_changes"
    | "explore"
    | "decompose"
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
};

export const ACTIVE_GENERATION_STATUSES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
] as const;

export function isActiveGenerationStatus(
  status: GenerationStatus["status"]
): boolean {
  return ACTIVE_GENERATION_STATUSES.includes(
    status as (typeof ACTIVE_GENERATION_STATUSES)[number]
  );
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

export type BatchCreateArtifactInput = {
  items: CreateArtifactInput[];
};

/**
 * Map of artifact slug to artifact title.
 * Returned by the batch-meta endpoint for lightweight name lookups.
 * Slugs not found in the org are omitted.
 */
export type ArtifactTitleMap = Record<string, string>;

/** Maximum number of slugs accepted by GET /artifacts/batch-meta */
export const BATCH_META_MAX_SLUGS = 50;
