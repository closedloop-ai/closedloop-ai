import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import { BoxIcon, FileIcon, FileTextIcon, ListCheckIcon } from "lucide-react";
import type * as React from "react";

// Priority display constants moved to @repo/app/shared/lib/priority-constants
// (unified across all entities, keyed by the shared Priority enum).

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
  [DocumentType.ImplementationPlan]: ListCheckIcon,
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
  // Violet matches the Feature badge the documents table has always rendered
  // (the table previously hardcoded violet and ignored this map's old amber).
  [DocumentType.Feature]: {
    bg: "bg-violet-100 dark:bg-violet-900/50",
    text: "text-violet-700 dark:text-violet-300",
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

// Branch (Pull Request) artifact status icons
export const BRANCH_STATUS_TO_ICON: Record<GitHubPRState, StatusIconStatus> = {
  [GitHubPRState.Open]: "in-progress",
  [GitHubPRState.Merged]: "complete",
  [GitHubPRState.Closed]: "wont-do",
};
