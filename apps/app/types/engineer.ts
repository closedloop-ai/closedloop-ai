/**
 * Engineer ticket types — adapted from closedloop-dev's EngineerTicket.
 * Maps Symphony FeatureWithWorkstream to the shape closedloop-dev components expect.
 */

import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
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
    case FeatureStatus.Draft:
      return "unstarted";
    case FeatureStatus.InProgress:
      return "started";
    case FeatureStatus.InReview:
      return "started";
    case FeatureStatus.Approved:
      return "started";
    case FeatureStatus.Executed:
      return "started";
    case FeatureStatus.Done:
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
    case FeatureStatus.Draft:
      return "Draft";
    case FeatureStatus.InProgress:
      return "In Progress";
    case FeatureStatus.InReview:
      return "In Review";
    case FeatureStatus.Approved:
      return "Approved";
    case FeatureStatus.Executed:
      return "Executed";
    case FeatureStatus.Done:
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

/** Map DocumentStatus to closedloop-dev status type */
export function mapDocumentStatusToType(
  status: DocumentStatus
): TicketStatusType {
  switch (status) {
    case DocumentStatus.Draft:
      return "started";
    case DocumentStatus.InProgress:
      return "started";
    case DocumentStatus.InReview:
      return "started";
    case DocumentStatus.Approved:
      return "started";
    case DocumentStatus.Executed:
      return "started";
    case DocumentStatus.Done:
      return "completed";
    case DocumentStatus.Obsolete:
      return "canceled";
    default:
      return "unstarted";
  }
}

/** Map DocumentStatus to display name */
export function artifactStatusDisplayName(status: DocumentStatus): string {
  switch (status) {
    case DocumentStatus.Draft:
      return "Draft";
    case DocumentStatus.InProgress:
      return "In Progress";
    case DocumentStatus.InReview:
      return "In Review";
    case DocumentStatus.Approved:
      return "Approved";
    case DocumentStatus.Executed:
      return "Executed";
    case DocumentStatus.Done:
      return "Done";
    case DocumentStatus.Obsolete:
      return "Obsolete";
    default:
      return status;
  }
}

/** Map document type string to display label */
export function documentTypeToSourceType(type: DocumentType): TicketSourceType {
  switch (type) {
    case DocumentType.Prd:
      return TicketSourceType.Prd;
    case DocumentType.ImplementationPlan:
      return TicketSourceType.ImplementationPlan;
    case DocumentType.Template:
      return TicketSourceType.Template;
    default:
      return TicketSourceType.Prd;
  }
}
