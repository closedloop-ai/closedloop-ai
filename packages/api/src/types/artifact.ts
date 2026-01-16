// Artifact and Approval types for API contract
// These are explicitly defined to keep packages/api independent of database

export const ARTIFACT_TYPE_OPTIONS = [
  "PRD",
  "FIGMA_DESIGN",
  "IMPLEMENTATION_PLAN",
  "CODE_REVIEW_REPORT",
  "VISUAL_QA_REPORT",
  "ACCESSIBILITY_REPORT",
  "TEST_REPORT",
  "COMPLETION_SUMMARY",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPE_OPTIONS)[number];

export const ARTIFACT_STATUS_OPTIONS = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "ARCHIVED",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUS_OPTIONS)[number];

export const APPROVAL_STATUS_OPTIONS = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REVISION_REQUESTED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS_OPTIONS)[number];

export const APPROVER_ROLE_OPTIONS = [
  "PM",
  "DESIGNER",
  "TECH_LEAD",
  "ENGINEER",
  "STAKEHOLDER",
] as const;
export type ApproverRole = (typeof APPROVER_ROLE_OPTIONS)[number];

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
