/**
 * Engineer ticket types — adapted from closedloop-dev's EngineerTicket.
 * Maps Symphony FeatureWithWorkstream to the shape closedloop-dev components expect.
 */

import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { FeatureStatus } from "@repo/api/src/types/feature";

export type TicketStatusType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export const TicketSourceType = {
  Feature: "Feature",
  Prd: "PRD",
  ImplementationPlan: "Implementation Plan",
  Template: "Template",
} as const;
export type TicketSourceType =
  (typeof TicketSourceType)[keyof typeof TicketSourceType];

export type EngineerTicket = {
  id: string;
  identifier: string; // feature slug (replaces Linear's "CHC-1234" format)
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
  url: string; // Link to the feature in Symphony
  // Symphony-specific fields
  featureId?: string; // The actual Symphony feature UUID (only set for Feature-sourced tickets)
  projectName?: string;
  workstreamTitle?: string;
};

export type EngineerTicketsResult = {
  tickets: EngineerTicket[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
};

/** Map Symphony FeatureStatus to closedloop-dev status type */
export function mapFeatureStatusToType(
  status: FeatureStatus
): TicketStatusType {
  switch (status) {
    case FeatureStatus.NotStarted:
      return "unstarted";
    case FeatureStatus.InProgress:
      return "started";
    case FeatureStatus.InReview:
      return "started";
    case FeatureStatus.Completed:
      return "completed";
    case FeatureStatus.Obsolete:
      return "canceled";
    default:
      return "unstarted";
  }
}

/** Map Symphony FeatureStatus to display name */
export function statusDisplayName(status: FeatureStatus): string {
  switch (status) {
    case FeatureStatus.NotStarted:
      return "Not Started";
    case FeatureStatus.InProgress:
      return "In Progress";
    case FeatureStatus.InReview:
      return "In Review";
    case FeatureStatus.Completed:
      return "Done";
    case FeatureStatus.Obsolete:
      return "Obsolete";
    default:
      return status;
  }
}

/** Map Symphony FeaturePriority to numeric value (higher = more urgent) */
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

/** Map Symphony FeaturePriority to display label */
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
      return "started";
    case ArtifactStatus.Obsolete:
      return "canceled";
    case ArtifactStatus.ReadyForReview:
      return "started";
    case ArtifactStatus.Executed:
      return "completed";
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
    case ArtifactStatus.ReadyForReview:
      return "Ready for Review";
    case ArtifactStatus.Executed:
      return "Executed";
    default:
      return status;
  }
}

/** Map artifact type string to display label */
export function artifactTypeToSourceType(type: ArtifactType): TicketSourceType {
  switch (type) {
    case ArtifactType.Prd:
      return TicketSourceType.Prd;
    case ArtifactType.ImplementationPlan:
      return TicketSourceType.ImplementationPlan;
    case ArtifactType.Template:
      return TicketSourceType.Template;
    default:
      return TicketSourceType.Prd;
  }
}
