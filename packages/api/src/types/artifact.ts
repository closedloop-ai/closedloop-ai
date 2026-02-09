// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { ProjectOwner } from "./organization";

/**
 * Broad classification for artifacts:
 * - Document: Text-based artifacts editable in the app (PRD, Issue, Bug, reports, etc.)
 * - Workflow: User-defined step sequences that orchestrate execution (e.g., plan -> code -> test -> review)
 * - Branch: Code-related artifacts tied to version control (e.g., Pull Requests)
 *
 * Note: UI sections use type-based grouping for granularity, not category-based filtering.
 * Category enables future features like category-specific views or permissions.
 */
export const ArtifactCategory = {
  Document: "DOCUMENT",
  Workflow: "WORKFLOW",
  Branch: "BRANCH",
} as const;
export type ArtifactCategory =
  (typeof ArtifactCategory)[keyof typeof ArtifactCategory];
export const ARTIFACT_CATEGORY_OPTIONS = Object.values(ArtifactCategory);

// Artifact Type
export const ArtifactType = {
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
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];
export const ARTIFACT_TYPE_OPTIONS = Object.values(ArtifactType);

/**
 * Maps an ArtifactType to its corresponding ArtifactCategory.
 * Uses exhaustive switch to ensure compile-time errors if new types are added without mapping.
 */
export function getArtifactCategory(type: ArtifactType): ArtifactCategory {
  switch (type) {
    // Document types
    case ArtifactType.Prd:
    case ArtifactType.Issue:
    case ArtifactType.Bug:
    case ArtifactType.Template:
    case ArtifactType.ImplementationPlan:
    case ArtifactType.ImplementationStrategy:
    case ArtifactType.CodeReviewReport:
    case ArtifactType.VisualQaReport:
    case ArtifactType.AccessibilityReport:
    case ArtifactType.TestReport:
    case ArtifactType.CompletionSummary:
      return ArtifactCategory.Document;

    // Workflow types
    case ArtifactType.FigmaDesign:
      return ArtifactCategory.Workflow;

    // Branch types
    case ArtifactType.PullRequest:
      return ArtifactCategory.Branch;

    default: {
      // Exhaustive check: if a new ArtifactType is added without a mapping,
      // TypeScript will error here because `type` won't be assignable to `never`
      const _exhaustiveCheck: never = type;
      throw new Error(`Unmapped ArtifactType: ${_exhaustiveCheck}`);
    }
  }
}

/**
 * Document types that generate a documentSlug for navigation.
 * Templates are NOT navigable and do NOT get documentSlug.
 */
const NAVIGABLE_DOCUMENT_TYPES = new Set<ArtifactType>([
  ArtifactType.Prd,
  ArtifactType.ImplementationPlan,
  ArtifactType.Issue,
  ArtifactType.Bug,
  ArtifactType.ImplementationStrategy,
]);

/**
 * Determines whether an artifact type should have a document slug generated.
 * Document slugs enable stable URLs for navigation across artifact versions.
 *
 * @param type - The artifact type to check
 * @returns true if the artifact type should have a document slug
 */
export function shouldGenerateDocumentSlug(type: ArtifactType): boolean {
  return NAVIGABLE_DOCUMENT_TYPES.has(type);
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
  category: ArtifactCategory | null;
  title: string;
  fileName: string | null;
  approver: string | null;
  status: ArtifactStatus;
  content: string | null;
  externalUrl: string | null;
  version: number;
  isLatest: boolean;
  documentSlug: string | null;
  generatedBy: string | null;
  ownerId: string | null;
  tokenUsage: unknown;
  targetRepo: string | null;
  targetBranch: string | null;
  templateForType: ArtifactType | null;
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
  previewDeployment?: PreviewDeployment | null;
};

export type FindArtifactsOptions = {
  type?: ArtifactType;
  category?: ArtifactCategory;
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
  type: ArtifactType;
  category?: ArtifactCategory;
  title: string;
  fileName?: string;
  approver?: string;
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
  approver?: string | null;
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
