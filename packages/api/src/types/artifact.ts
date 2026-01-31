// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

// Artifact Type
export const ArtifactType = {
  Prd: "PRD",
  FigmaDesign: "FIGMA_DESIGN",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  CodeReviewReport: "CODE_REVIEW_REPORT",
  VisualQaReport: "VISUAL_QA_REPORT",
  AccessibilityReport: "ACCESSIBILITY_REPORT",
  TestReport: "TEST_REPORT",
  CompletionSummary: "COMPLETION_SUMMARY",
  PullRequest: "PULL_REQUEST",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];
export const ARTIFACT_TYPE_OPTIONS = Object.values(ArtifactType);

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
  workstreamId: string | null;
  projectId: string | null;
  parentId: string | null;
  type: ArtifactType;
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
  tokenUsage: unknown;
  targetRepo: string | null;
  targetBranch: string | null;
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
};

export type FindArtifactsOptions = {
  type?: ArtifactType;
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
  title: string;
  fileName?: string;
  approver?: string;
  status?: ArtifactStatus;
  content?: string;
  externalUrl?: string;
  targetRepo?: string;
  targetBranch?: string;
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
