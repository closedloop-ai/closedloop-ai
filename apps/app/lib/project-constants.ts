import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import { BoxIcon, FileCode2Icon, FileIcon, FileTextIcon } from "lucide-react";
import type * as React from "react";

// Priority configuration (unified across all entities)
export const PRIORITY_LABELS: Record<Priority, string> = {
  [Priority.Low]: "Low",
  [Priority.Medium]: "Medium",
  [Priority.High]: "High",
  [Priority.Urgent]: "Urgent",
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  [Priority.Low]: "text-blue-600 dark:text-blue-400",
  [Priority.Medium]: "text-yellow-600 dark:text-yellow-400",
  [Priority.High]: "text-red-600 dark:text-red-400",
  [Priority.Urgent]: "text-red-800 dark:text-red-300",
};

// Artifact status configuration (uses API status directly — no display mapping)
export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "Draft",
  [DocumentStatus.InProgress]: "In Progress",
  [DocumentStatus.InReview]: "In Review",
  [DocumentStatus.Approved]: "Approved",
  [DocumentStatus.Executed]: "Executed",
  [DocumentStatus.Done]: "Done",
  [DocumentStatus.Obsolete]: "Obsolete",
};

export const DOCUMENT_STATUS_COLORS: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "text-muted-foreground",
  [DocumentStatus.InProgress]: "text-blue-600 dark:text-blue-400",
  [DocumentStatus.InReview]: "text-blue-600 dark:text-blue-400",
  [DocumentStatus.Approved]: "text-blue-600 dark:text-blue-400",
  [DocumentStatus.Executed]: "text-blue-600 dark:text-blue-400",
  [DocumentStatus.Done]: "text-green-600 dark:text-green-400",
  [DocumentStatus.Obsolete]: "text-muted-foreground",
};

export const DOCUMENT_STATUS_TO_ICON: Record<DocumentStatus, StatusIconStatus> =
  {
    [DocumentStatus.Draft]: "todo",
    [DocumentStatus.InProgress]: "started",
    [DocumentStatus.InReview]: "in-progress",
    [DocumentStatus.Approved]: "in-review",
    [DocumentStatus.Executed]: "executed",
    [DocumentStatus.Done]: "complete",
    [DocumentStatus.Obsolete]: "wont-do",
  };

// Artifact type icons
export const DOCUMENT_TYPE_ICONS: Record<DocumentType, React.ElementType> = {
  [DocumentType.Prd]: FileIcon,
  [DocumentType.ImplementationPlan]: FileCode2Icon,
  [DocumentType.Template]: FileTextIcon,
  [DocumentType.Feature]: BoxIcon,
};

// Artifact type labels for display
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Implementation Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Feature",
};

// Artifact type colors for pills (bg + text)
export const DOCUMENT_TYPE_COLORS: Record<
  DocumentType,
  { bg: string; text: string }
> = {
  [DocumentType.Prd]: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  [DocumentType.ImplementationPlan]: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  [DocumentType.Template]: {
    bg: "bg-indigo-100 dark:bg-indigo-900/50",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  [DocumentType.Feature]: {
    bg: "bg-amber-100 dark:bg-amber-900/50",
    text: "text-amber-700 dark:text-amber-300",
  },
};

// Artifact type short badge labels (for compact displays like Context table)
export const DOCUMENT_TYPE_BADGE_LABELS: Record<DocumentType, string> = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Feature",
};

// Project status labels
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  [ProjectStatus.NotStarted]: "Not Started",
  [ProjectStatus.InProgress]: "In Progress",
  [ProjectStatus.Completed]: "Completed",
  [ProjectStatus.Archived]: "Archived",
};
