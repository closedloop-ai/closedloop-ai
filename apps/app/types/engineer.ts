/**
 * Engineer ticket types — adapted from closedloop-dev's EngineerTicket.
 * Maps Symphony IssueWithWorkstream to the shape closedloop-dev components expect.
 */

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
export function mapIssueStatusToType(status: string): TicketStatusType {
  switch (status) {
    case "TODO":
      return "unstarted";
    case "IN_PROGRESS":
      return "started";
    case "IN_REVIEW":
      return "started";
    case "CLOSED":
      return "completed";
    default:
      return "unstarted";
  }
}

/** Map Symphony IssueStatus to display name */
export function statusDisplayName(status: string): string {
  switch (status) {
    case "TODO":
      return "To Do";
    case "IN_PROGRESS":
      return "In Progress";
    case "IN_REVIEW":
      return "In Review";
    case "CLOSED":
      return "Done";
    default:
      return status;
  }
}

/** Map Symphony IssuePriority to numeric value (higher = more urgent) */
export function priorityToNumber(priority: string): number {
  switch (priority) {
    case "URGENT":
      return 1;
    case "HIGH":
      return 2;
    case "MEDIUM":
      return 3;
    case "LOW":
      return 4;
    default:
      return 3;
  }
}

/** Map Symphony IssuePriority to display label */
export function priorityToLabel(priority: string): string {
  switch (priority) {
    case "URGENT":
      return "Urgent";
    case "HIGH":
      return "High";
    case "MEDIUM":
      return "Medium";
    case "LOW":
      return "Low";
    default:
      return "Medium";
  }
}

/** Map ArtifactStatus to closedloop-dev status type */
export function mapArtifactStatusToType(status: string): TicketStatusType {
  switch (status) {
    case "DRAFT":
      return "started";
    case "REVIEW":
      return "started";
    case "APPROVED":
      return "completed";
    case "ARCHIVED":
      return "completed";
    default:
      return "unstarted";
  }
}

/** Map ArtifactStatus to display name */
export function artifactStatusDisplayName(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "REVIEW":
      return "In Review";
    case "APPROVED":
      return "Approved";
    case "ARCHIVED":
      return "Archived";
    default:
      return status;
  }
}

/** Map artifact type string to display label */
export function artifactTypeToSourceType(type: string): TicketSourceType {
  switch (type) {
    case "PRD":
      return "PRD";
    case "IMPLEMENTATION_PLAN":
      return "Implementation Plan";
    case "TEMPLATE":
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
  status: string;
  priority: string;
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
  type: string;
  status: string;
  snippet: string | null;
  projectId: string | null;
  workstreamId: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  owner: {
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
  type: string;
  status: string;
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
