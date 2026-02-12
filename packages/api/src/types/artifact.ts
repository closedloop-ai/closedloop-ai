// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

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
 * Broad classification for artifacts:
 * - Document: Text-based artifacts editable in the app (PRD, Issue, Bug, reports, etc.)
 * - Workflow: User-defined step sequences that orchestrate execution (e.g., plan -> code -> test -> review)
 * - Branch: Code-related artifacts tied to version control (e.g., Pull Requests)
 *
 * Note: UI sections use subtype-based grouping for granularity, not type-based filtering.
 * Type enables future features like type-specific views or permissions.
 */
export const ArtifactType = {
  Document: "DOCUMENT",
  Workflow: "WORKFLOW",
  Branch: "BRANCH",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];
export const ARTIFACT_TYPE_OPTIONS = Object.values(ArtifactType);

// Artifact Subtype
export const ArtifactSubtype = {
  Prd: "PRD",
  Issue: "ISSUE",
  Bug: "BUG",
  Template: "TEMPLATE",
  FigmaDesign: "FIGMA_DESIGN",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  ImplementationStrategy: "IMPLEMENTATION_STRATEGY",
  CodeReviewReport: "CODE_REVIEW_REPORT",
  VisualQaReport: "VISUAL_QA_REPORT",
  AccessibilityReport: "ACCESSIBILITY_REPORT",
  TestReport: "TEST_REPORT",
  CompletionSummary: "COMPLETION_SUMMARY",
  PullRequest: "PULL_REQUEST",
} as const;
export type ArtifactSubtype =
  (typeof ArtifactSubtype)[keyof typeof ArtifactSubtype];
export const ARTIFACT_SUBTYPE_OPTIONS = Object.values(ArtifactSubtype);

/**
 * Maps an ArtifactSubtype to its corresponding ArtifactType.
 * Uses exhaustive switch to ensure compile-time errors if new subtypes are added without mapping.
 */
export function getArtifactType(subtype: ArtifactSubtype): ArtifactType {
  switch (subtype) {
    // Document types
    case ArtifactSubtype.Prd:
    case ArtifactSubtype.Issue:
    case ArtifactSubtype.Bug:
    case ArtifactSubtype.Template:
    case ArtifactSubtype.ImplementationPlan:
    case ArtifactSubtype.ImplementationStrategy:
    case ArtifactSubtype.CodeReviewReport:
    case ArtifactSubtype.VisualQaReport:
    case ArtifactSubtype.AccessibilityReport:
    case ArtifactSubtype.TestReport:
    case ArtifactSubtype.CompletionSummary:
      return ArtifactType.Document;

    // Workflow types
    case ArtifactSubtype.FigmaDesign:
      return ArtifactType.Workflow;

    // Branch types
    case ArtifactSubtype.PullRequest:
      return ArtifactType.Branch;

    default: {
      // Exhaustive check: if a new ArtifactSubtype is added without a mapping,
      // TypeScript will error here because `subtype` won't be assignable to `never`
      const _exhaustiveCheck: never = subtype;
      throw new Error(`Unmapped ArtifactSubtype: ${_exhaustiveCheck}`);
    }
  }
}

/**
 * Document subtypes that generate a documentSlug for navigation.
 * Templates are NOT navigable and do NOT get documentSlug.
 */
const NAVIGABLE_DOCUMENT_TYPES = new Set<ArtifactSubtype>([
  ArtifactSubtype.Prd,
  ArtifactSubtype.ImplementationPlan,
  ArtifactSubtype.Issue,
  ArtifactSubtype.Bug,
  ArtifactSubtype.ImplementationStrategy,
]);

/**
 * Determines whether an artifact subtype should have a document slug generated.
 * Document slugs enable stable URLs for navigation across artifact versions.
 *
 * @param subtype - The artifact subtype to check
 * @returns true if the artifact subtype should have a document slug
 */
export function shouldGenerateDocumentSlug(subtype: ArtifactSubtype): boolean {
  return NAVIGABLE_DOCUMENT_TYPES.has(subtype);
}

/**
 * Maps navigable artifact subtypes to their URL route prefixes.
 * Single source of truth for subtype→route mapping used by:
 * - apps/app/lib/artifact-navigation.ts (frontend navigation)
 * - apps/app/app/(authenticated)/artifacts/[slug]/page.tsx (redirect fallback)
 * - packages/collaboration/room-metadata.ts (Liveblocks notification URLs)
 */
export const SUBTYPE_ROUTE_PREFIX: Partial<Record<ArtifactSubtype, string>> = {
  PRD: "prds",
  IMPLEMENTATION_PLAN: "implementation-plans",
  IMPLEMENTATION_STRATEGY: "implementation-plans",
  ISSUE: "issues",
  BUG: "issues",
};

/**
 * Returns the route prefix for a navigable artifact subtype, or null if not navigable.
 * Accepts raw strings (e.g. from Liveblocks room metadata) in addition to typed subtypes.
 */
export function getRoutePrefixForSubtype(subtype: string): string | null {
  if (subtype in SUBTYPE_ROUTE_PREFIX) {
    return SUBTYPE_ROUTE_PREFIX[subtype as ArtifactSubtype] ?? null;
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

// Approval Status
export const ApprovalStatus = {
  Pending: "PENDING",
  Approved: "APPROVED",
  Rejected: "REJECTED",
  RevisionRequested: "REVISION_REQUESTED",
} as const;
export type ApprovalStatus =
  (typeof ApprovalStatus)[keyof typeof ApprovalStatus];
export const APPROVAL_STATUS_OPTIONS = Object.values(ApprovalStatus);

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
  parentId: string | null;
  type: ArtifactType;
  subtype: ArtifactSubtype;
  title: string;
  fileName: string | null;
  owner: ArtifactUser | null;
  approver: ArtifactUser | null;
  status: ArtifactStatus;
  content: string | null;
  externalUrl: string | null;
  version: number;
  isLatest: boolean;
  documentSlug: string | null;
  generatedBy: string | null;
  ownerId: string | null;
  approverId: string | null;
  tokenUsage: unknown | null;
  targetRepo: string | null;
  targetBranch: string | null;
  templateForSubtype: ArtifactSubtype | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PreviewDeployment = {
  url: string | null;
  state: string | null;
  environment: string | null;
  ref: string | null;
  sha: string | null;
  updatedAt: Date | null;
};

export type ParentArtifactInfo = {
  id: string;
  title: string;
  subtype: ArtifactSubtype;
  documentSlug: string | null;
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
  parent?: ParentArtifactInfo | null;
  previewDeployment?: PreviewDeployment | null;
  pullRequest?: PullRequestInfo | null;
  /** The latest generation status for this artifact. Omitted when no generation status is available. */
  generationStatus?: GenerationStatus;
};

export type FindArtifactsOptions = {
  type?: ArtifactType;
  subtype?: ArtifactSubtype;
  latestOnly?: boolean;
  workstreamId?: string;
  projectId?: string;
  documentSlug?: string;
  version?: number;
};

export type CreateArtifactInput = {
  workstreamId?: string;
  projectId?: string;
  parentId?: string;
  subtype: ArtifactSubtype;
  title: string;
  fileName?: string;
  approverId?: string;
  status?: ArtifactStatus;
  content?: string;
  externalUrl?: string;
  targetRepo?: string;
  targetBranch?: string;
  /**
   * Owner user ID. Defaults to the authenticated user if not provided.
   * Must reference a valid user in the organization.
   */
  ownerId?: string;
};

export type UpdateArtifactInput = {
  id: string;
  title?: string;
  fileName?: string;
  parentId?: string | null;
  projectId?: string | null;
  approverId?: string | null;
  status?: ArtifactStatus;
  externalUrl?: string | null;
  targetRepo?: string | null;
  targetBranch?: string | null;
  ownerId?: string | null;
};

export type Approval = {
  id: string;
  workstreamId: string;
  artifactId: string;
  requiredRole: ApproverRole;
  approverId: string | null;
  status: ApprovalStatus;
  feedback: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
};

export type CreateApprovalInput = {
  workstreamId: string;
  artifactId: string;
  requiredRole: ApproverRole;
  approverId?: string;
};

export type UpdateApprovalInput = {
  id: string;
  status: ApprovalStatus;
  feedback?: string;
  approverId?: string;
};

// Pull Request info returned when an implementation plan is executed
export type PullRequestInfo = {
  id: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headBranch: string;
  baseBranch: string;
  createdAt: Date;
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
