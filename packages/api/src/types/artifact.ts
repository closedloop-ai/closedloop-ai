// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { ArtifactVersion } from "./artifact-version";
import type { EntityType } from "./entity-link";
import type { ProjectOwner } from "./organization";

/**
 * Minimal user info included with artifacts for display purposes.
 * Matches the select pattern in artifactIncludeWithContext.
 */
export type ArtifactUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

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
  Review: "REVIEW",
  Approved: "APPROVED",
  Archived: "ARCHIVED",
} as const;
export type ArtifactStatus =
  (typeof ArtifactStatus)[keyof typeof ArtifactStatus];
export const ARTIFACT_STATUS_OPTIONS = Object.values(ArtifactStatus);

// Approver Role
export const ApproverRole = {
  Pm: "PM",
  Designer: "DESIGNER",
  TechLead: "TECH_LEAD",
  Engineer: "ENGINEER",
  Stakeholder: "STAKEHOLDER",
} as const;
export type ApproverRole = (typeof ApproverRole)[keyof typeof ApproverRole];
export const APPROVER_ROLE_OPTIONS = Object.values(ApproverRole);

export type Artifact = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string | null;
  type: ArtifactType;
  title: string;
  slug: string;
  fileName: string | null;
  owner: ArtifactUser | null;
  approver: ArtifactUser | null;
  status: ArtifactStatus;
  latestVersion: number;
  generatedBy: string | null;
  ownerId: string | null;
  approverId: string | null;
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
    state: string;
  } | null;
  project?: {
    id: string;
    name: string;
    teams?: { id: string; name: string }[];
  } | null;
  owner?: ProjectOwner | null;
  /** The latest generation status for this artifact. Omitted when no generation status is available. */
  generationStatus?: GenerationStatus;
};

/** Detail response from GET /artifacts/:id and GET /artifacts/by-slug/:slug. Always includes version content. */
export type ArtifactDetail = ArtifactWithWorkstream & {
  version: ArtifactVersion;
};

export type FindArtifactsOptions = {
  type?: ArtifactType;
  workstreamId?: string;
  projectId?: string;
  ownerId?: string;
};

export type CreateArtifactInput = {
  workstreamId?: string;
  projectId?: string;
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
  ownerId?: string;
  templateForType?: ArtifactType | null;
};

export type UpdateArtifactInput = {
  id: string;
  title?: string;
  fileName?: string;
  projectId?: string | null;
  approverId?: string | null;
  status?: ArtifactStatus;
  targetRepo?: string | null;
  targetBranch?: string | null;
  ownerId?: string | null;
  sortOrder?: number | null;
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
  reviewDecision: ReviewDecision | null;
};

// Generation status for artifacts being processed by GitHub Actions
export type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  command: "plan" | "execute" | "chat" | null;
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
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

// Plan JSON types for experimental plugin artifacts
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
