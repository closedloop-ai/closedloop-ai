import type { Priority } from "./common";
import type { BasicUser } from "./user";

export const IssueStatus = {
  NotStarted: "NOT_STARTED",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Completed: "COMPLETED",
  Obsolete: "OBSOLETE",
} as const;
export type IssueStatus = (typeof IssueStatus)[keyof typeof IssueStatus];
export const ISSUE_STATUS_OPTIONS = Object.values(IssueStatus);

export type Issue = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string;
  title: string;
  slug: string;
  description: string | null;
  status: IssueStatus;
  priority: Priority;
  assigneeId: string | null;
  assignee: BasicUser | null;
  createdById: string;
  createdBy: BasicUser | null;
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
};

export type FindIssuesOptions = {
  workstreamId?: string;
  projectId?: string;
  status?: IssueStatus;
  priority?: Priority;
  assigneeId?: string;
};

export type CreateIssueInput = {
  workstreamId?: string;
  projectId: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: Priority;
  assigneeId?: string;
};

export type UpdateIssueInput = {
  id: string;
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: Priority;
  assigneeId?: string | null;
  projectId?: string;
};
