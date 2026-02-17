// Issue types for API contract

import type { ArtifactUser } from "./artifact";
import type { ProjectOwner } from "./organization";

export const IssueStatus = {
  Todo: "TODO",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Closed: "CLOSED",
} as const;
export type IssueStatus = (typeof IssueStatus)[keyof typeof IssueStatus];
export const ISSUE_STATUS_OPTIONS = Object.values(IssueStatus);

export const IssuePriority = {
  Low: "LOW",
  Medium: "MEDIUM",
  High: "HIGH",
  Urgent: "URGENT",
} as const;
export type IssuePriority = (typeof IssuePriority)[keyof typeof IssuePriority];
export const ISSUE_PRIORITY_OPTIONS = Object.values(IssuePriority);

export type Issue = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string | null;
  title: string;
  slug: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  assignee: ArtifactUser | null;
  createdById: string;
  createdBy: ArtifactUser | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IssueWithWorkstream = Issue & {
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
  assignee?: ProjectOwner | null;
  createdBy?: ProjectOwner | null;
};

export type FindIssuesOptions = {
  workstreamId?: string;
  projectId?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string;
};

export type CreateIssueInput = {
  workstreamId?: string;
  projectId?: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string;
};

export type UpdateIssueInput = {
  id: string;
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string | null;
  projectId?: string | null;
};
