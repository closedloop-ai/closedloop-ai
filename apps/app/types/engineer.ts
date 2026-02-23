/**
 * Engineer ticket types — adapted from closedloop-dev's EngineerTicket.
 * Maps Symphony IssueWithWorkstream to the shape closedloop-dev components expect.
 */

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { getRoutePrefixForType } from "@repo/api/src/types/artifact";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";

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
  issueId: string; // The actual Symphony issue UUID
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

/** Convert a Symphony ArtifactWithWorkstream (PRD) to an EngineerTicket */
export function artifactToEngineerTicket(
  artifact: ArtifactWithWorkstream
): EngineerTicket {
  const owner = artifact.owner
    ? {
        id: artifact.owner.id,
        name: [artifact.owner.firstName, artifact.owner.lastName]
          .filter(Boolean)
          .join(" "),
        email: "",
        avatarUrl: artifact.owner.avatarUrl ?? undefined,
      }
    : undefined;

  const routePrefix = getRoutePrefixForType(artifact.type) ?? "artifacts";

  return {
    id: artifact.id,
    identifier: artifact.slug,
    title: artifact.title,
    description: artifact.snippet ?? undefined,
    sourceType: artifactTypeToSourceType(artifact.type),
    status: {
      id: artifact.status,
      name: artifactStatusDisplayName(artifact.status),
      type: mapArtifactStatusToType(artifact.status),
    },
    assignee: owner,
    priority: 3,
    priorityLabel: "Medium",
    createdAt: artifact.createdAt.toString(),
    updatedAt: artifact.updatedAt.toString(),
    url: `/${routePrefix}/${artifact.slug}`,
    issueId: artifact.id,
    projectName: artifact.project?.name ?? undefined,
    workstreamTitle: artifact.workstream?.title ?? undefined,
  };
}

/** Convert a Symphony IssueWithWorkstream to an EngineerTicket */
export function issueToEngineerTicket(
  issue: IssueWithWorkstream
): EngineerTicket {
  const assignee = issue.assignee
    ? {
        id: issue.assignee.id,
        name: [issue.assignee.firstName, issue.assignee.lastName]
          .filter(Boolean)
          .join(" "),
        email: "", // Not available on ProjectOwner type
        avatarUrl: issue.assignee.avatarUrl ?? undefined,
      }
    : undefined;

  return {
    id: issue.id,
    identifier: issue.slug,
    title: issue.title,
    description: issue.description ?? undefined,
    sourceType: "Issue",
    status: {
      id: issue.status,
      name: statusDisplayName(issue.status),
      type: mapIssueStatusToType(issue.status),
    },
    assignee,
    priority: priorityToNumber(issue.priority),
    priorityLabel: priorityToLabel(issue.priority),
    createdAt: issue.createdAt.toString(),
    updatedAt: issue.updatedAt.toString(),
    url: `/issues/${issue.slug}`,
    issueId: issue.id,
    projectName: issue.project?.name ?? undefined,
    workstreamTitle: issue.workstream?.title ?? undefined,
  };
}
