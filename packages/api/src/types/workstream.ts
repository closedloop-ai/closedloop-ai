// Workstream types for API contract
// These are explicitly defined to keep packages/api independent of database

export const WORKSTREAM_TYPE_OPTIONS = [
  "FEATURE_DELIVERY",
  "BUG_FIX",
  "TECH_DEBT",
  "SPIKE",
] as const;
export type WorkstreamType = (typeof WORKSTREAM_TYPE_OPTIONS)[number];

export const WORKSTREAM_STATE_OPTIONS = [
  "INITIATED",
  "REQUIREMENTS_GENERATING",
  "REQUIREMENTS_PENDING_APPROVAL",
  "DESIGN_IN_PROGRESS",
  "DESIGN_PENDING_APPROVAL",
  "IMPLEMENTATION_PLANNING",
  "IMPLEMENTATION_IN_PROGRESS",
  "IMPLEMENTATION_PENDING_REVIEW",
  "CODE_REVIEW_RUNNING",
  "CODE_REVIEW_PENDING_APPROVAL",
  "VISUAL_QA_RUNNING",
  "VISUAL_QA_PENDING_APPROVAL",
  "MERGING",
  "DEPLOYED",
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
] as const;
export type WorkstreamState = (typeof WORKSTREAM_STATE_OPTIONS)[number];

export const WORKSTREAM_EVENT_TYPE_OPTIONS = [
  "STATE_CHANGED",
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "REVISION_REQUESTED",
  "LINEAR_ISSUE_CREATED",
  "LINEAR_ISSUE_UPDATED",
  "LINEAR_SUBTASK_CREATED",
  "GITHUB_PR_CREATED",
  "GITHUB_PR_MERGED",
  "GITHUB_PR_CLOSED",
  "GITHUB_ACTION_TRIGGERED",
  "GITHUB_ACTION_COMPLETED",
  "GITHUB_CI_STATUS_CHANGED",
  "SLACK_NOTIFICATION_SENT",
  "COMMENT_ADDED",
  "ASSIGNEE_CHANGED",
  "BLOCKED",
  "UNBLOCKED",
] as const;
export type WorkstreamEventType =
  (typeof WORKSTREAM_EVENT_TYPE_OPTIONS)[number];

export type Workstream = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  type: WorkstreamType;
  state: WorkstreamState;
  stateChangedAt: Date;
  createdById: string;
  assignedToId: string | null;
  hasUIChanges: boolean;
  startedAt: Date;
  completedAt: Date | null;
  metrics: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkstreamWithProject = Workstream & {
  project: {
    name: string;
  };
};

export type CreateWorkstreamInput = {
  projectId: string;
  title: string;
  description?: string;
  type?: WorkstreamType;
  assignedToId?: string | null;
  hasUIChanges?: boolean;
};

export type UpdateWorkstreamInput = {
  id: string;
  title?: string;
  description?: string;
  type?: WorkstreamType;
  state?: WorkstreamState;
  assignedToId?: string | null;
  hasUIChanges?: boolean;
};

export type WorkstreamEvent = {
  id: string;
  workstreamId: string;
  type: WorkstreamEventType;
  fromState: WorkstreamState | null;
  toState: WorkstreamState | null;
  actorId: string | null;
  actorType: string;
  data: unknown;
  createdAt: Date;
};
