// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

export const ArtifactType = {
  Prd: "PRD",
  FigmaDesign: "FIGMA_DESIGN",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  CodeReviewReport: "CODE_REVIEW_REPORT",
  VisualQaReport: "VISUAL_QA_REPORT",
  AccessibilityReport: "ACCESSIBILITY_REPORT",
  TestReport: "TEST_REPORT",
  CompletionSummary: "COMPLETION_SUMMARY",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export const ArtifactStatus = {
  Draft: "DRAFT",
  Review: "REVIEW",
  Approved: "APPROVED",
  Archived: "ARCHIVED",
} as const;
export type ArtifactStatus =
  (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

export const ApprovalStatus = {
  Pending: "PENDING",
  Approved: "APPROVED",
  Rejected: "REJECTED",
  RevisionRequested: "REVISION_REQUESTED",
} as const;
export type ApprovalStatus =
  (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const ApproverRole = {
  Pm: "PM",
  Designer: "DESIGNER",
  TechLead: "TECH_LEAD",
  Engineer: "ENGINEER",
  Stakeholder: "STAKEHOLDER",
} as const;
export type ApproverRole = (typeof ApproverRole)[keyof typeof ApproverRole];

export type Artifact = {
  id: string;
  workstreamId: string | null;
  projectId: string | null;
  type: ArtifactType;
  title: string;
  fileName: string | null;
  approver: string | null;
  status: ArtifactStatus;
  content: string | null;
  externalUrl: string | null;
  version: number;
  isLatest: boolean;
  parentId: string | null;
  documentSlug: string | null;
  generatedBy: string | null;
  tokenUsage: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type ArtifactWithWorkstream = Artifact & {
  workstream?: {
    id: string;
    title: string;
    state: string;
    project: {
      name: string;
    };
  } | null;
  project?: {
    id: string;
    name: string;
  } | null;
};

export type CreateArtifactInput = {
  workstreamId?: string;
  projectId?: string;
  type: ArtifactType;
  title: string;
  fileName?: string;
  approver?: string;
  status?: ArtifactStatus;
  content?: string;
  externalUrl?: string;
  generatedBy?: string;
  documentSlug?: string;
};

export type UpdateArtifactInput = {
  id: string;
  title?: string;
  fileName?: string;
  approver?: string;
  status?: ArtifactStatus;
  content?: string;
  externalUrl?: string;
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
