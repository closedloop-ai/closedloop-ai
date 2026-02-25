/**
 * Engineer ticket types — adapted from closedloop-dev's EngineerTicket.
 * Maps Symphony IssueWithWorkstream to the shape closedloop-dev components expect.
 */

import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/issue";

export type TicketStatusType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type TicketSourceType =
  | "Issue"
  | "PRD"
  | "Implementation Plan"
  | "Template";

export type EngineerTicket = {
  id: string;
  identifier: string; // issue slug (replaces Linear's "CHC-1234" format)
  title: string;
  description?: string;
  sourceType: TicketSourceType;
  status: {
    id: string;
    name: string;
    type: TicketStatusType;
  };
  assignee?: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
  };
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  url: string; // Link to the issue in Symphony
  // Symphony-specific fields
  issueId?: string; // The actual Symphony issue UUID (only set for Issue-sourced tickets)
  projectName?: string;
  workstreamTitle?: string;
};

export type EngineerTicketsResult = {
  tickets: EngineerTicket[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
};

/** Map Symphony IssueStatus to closedloop-dev status type */
export function mapIssueStatusToType(status: IssueStatus): TicketStatusType {
  switch (status) {
    case IssueStatus.NotStarted:
      return "unstarted";
    case IssueStatus.InProgress:
      return "started";
    case IssueStatus.InReview:
      return "started";
    case IssueStatus.Completed:
      return "completed";
    case IssueStatus.Obsolete:
      return "canceled";
    default:
      return "unstarted";
  }
}

/** Map Symphony IssueStatus to display name */
export function statusDisplayName(status: IssueStatus): string {
  switch (status) {
    case IssueStatus.NotStarted:
      return "Not Started";
    case IssueStatus.InProgress:
      return "In Progress";
    case IssueStatus.InReview:
      return "In Review";
    case IssueStatus.Completed:
      return "Done";
    case IssueStatus.Obsolete:
      return "Obsolete";
    default:
      return status;
  }
}

/** Map Symphony IssuePriority to numeric value (higher = more urgent) */
export function priorityToNumber(priority: Priority): number {
  switch (priority) {
    case Priority.Urgent:
      return 1;
    case Priority.High:
      return 2;
    case Priority.Medium:
      return 3;
    case Priority.Low:
      return 4;
    default:
      return 3;
  }
}

/** Map Symphony IssuePriority to display label */
export function priorityToLabel(priority: Priority): string {
  switch (priority) {
    case Priority.Urgent:
      return "Urgent";
    case Priority.High:
      return "High";
    case Priority.Medium:
      return "Medium";
    case Priority.Low:
      return "Low";
    default:
      return "Medium";
  }
}

/** Map ArtifactStatus to closedloop-dev status type */
export function mapArtifactStatusToType(
  status: ArtifactStatus
): TicketStatusType {
  switch (status) {
    case ArtifactStatus.Draft:
      return "started";
    case ArtifactStatus.InReview:
      return "started";
    case ArtifactStatus.Approved:
      return "completed";
    case ArtifactStatus.Obsolete:
      return "canceled";
    default:
      return "unstarted";
  }
}

/** Map ArtifactStatus to display name */
export function artifactStatusDisplayName(status: ArtifactStatus): string {
  switch (status) {
    case ArtifactStatus.Draft:
      return "Draft";
    case ArtifactStatus.InReview:
      return "In Review";
    case ArtifactStatus.Approved:
      return "Approved";
    case ArtifactStatus.Obsolete:
      return "Obsolete";
    default:
      return status;
  }
}

/** Map artifact type string to display label */
export function artifactTypeToSourceType(type: ArtifactType): TicketSourceType {
  switch (type) {
    case ArtifactType.Prd:
      return "PRD";
    case ArtifactType.ImplementationPlan:
      return "Implementation Plan";
    case ArtifactType.Template:
      return "Template";
    default:
      return "PRD";
  }
}

// ---------------------------------------------------------------------------
// MCP response types (engineer-local, not shared API types)
// ---------------------------------------------------------------------------

export type McpUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
};

export type McpIssue = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  status: IssueStatus;
  priority: Priority;
  projectId: string | null;
  workstreamId: string | null;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: {
    id: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  project: { name: string | null } | null;
  workstream: { title: string | null } | null;
};

export type McpArtifact = {
  id: string;
  title: string;
  slug: string;
  type: ArtifactType;
  status: ArtifactStatus;
  snippet: string | null;
  projectId: string | null;
  workstreamId: string | null;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  assignee: {
    id: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  project: { name: string | null } | null;
  workstream: { title: string | null } | null;
};

export type McpArtifactDetail = {
  id: string;
  title: string;
  slug: string;
  type: ArtifactType;
  status: ArtifactStatus;
  projectId: string | null;
  workstreamId: string | null;
  latestVersion: number | null;
  updatedAt: string;
  version: {
    id: string;
    version: number | null;
    createdAt: string;
    createdById: string | null;
    contentLength: number;
    content?: string;
  };
};
