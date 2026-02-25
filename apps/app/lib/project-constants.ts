import type {
  ArtifactStatus,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { ExternalLinkType } from "@repo/api/src/types/external-link";
import type { IssueStatus } from "@repo/api/src/types/issue";
import {
  AlertCircleIcon,
  ClipboardListIcon,
  FileTextIcon,
  GitBranchIcon,
  PaintbrushIcon,
} from "lucide-react";
import type * as React from "react";

// Priority configuration (unified across all entities)
export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "text-blue-600 dark:text-blue-400",
  MEDIUM: "text-yellow-600 dark:text-yellow-400",
  HIGH: "text-red-600 dark:text-red-400",
  URGENT: "text-red-800 dark:text-red-300",
};

// Artifact status configuration (uses API status directly — no display mapping)
export const ARTIFACT_STATUS_LABELS: Record<ArtifactStatus, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  OBSOLETE: "Obsolete",
};

export const ARTIFACT_STATUS_COLORS: Record<ArtifactStatus, string> = {
  DRAFT: "text-muted-foreground",
  IN_REVIEW: "text-yellow-600 dark:text-yellow-400",
  APPROVED: "text-green-600 dark:text-green-400",
  OBSOLETE: "text-muted-foreground",
};

// Artifact type icons
export const ARTIFACT_TYPE_ICONS: Record<string, React.ElementType> = {
  PRD: FileTextIcon,
  IMPLEMENTATION_PLAN: ClipboardListIcon,
  TEMPLATE: FileTextIcon,
};

// Artifact type labels for display
export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  PRD: "PRD",
  IMPLEMENTATION_PLAN: "Implementation Plan",
  TEMPLATE: "Template",
};

// Artifact type colors for pills (bg + text)
export const ARTIFACT_TYPE_COLORS: Record<
  string,
  { bg: string; text: string }
> = {
  PRD: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  IMPLEMENTATION_PLAN: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  TEMPLATE: {
    bg: "bg-indigo-100 dark:bg-indigo-900/50",
    text: "text-indigo-700 dark:text-indigo-300",
  },
};

// Issue status labels and colors
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  COMPLETED: "Completed",
  OBSOLETE: "Obsolete",
};

export const ISSUE_STATUS_COLORS: Record<IssueStatus, string> = {
  NOT_STARTED: "text-muted-foreground",
  IN_PROGRESS: "text-blue-600 dark:text-blue-400",
  IN_REVIEW: "text-yellow-600 dark:text-yellow-400",
  COMPLETED: "text-green-600 dark:text-green-400",
  OBSOLETE: "text-muted-foreground",
};

// External link type icons
export const EXTERNAL_LINK_TYPE_ICONS: Record<string, React.ElementType> = {
  PULL_REQUEST: GitBranchIcon,
  FIGMA_DESIGN: PaintbrushIcon,
  PREVIEW_DEPLOYMENT: FileTextIcon,
};

// External link type labels
export const EXTERNAL_LINK_TYPE_LABELS: Record<ExternalLinkType, string> = {
  PULL_REQUEST: "Pull Request",
  FIGMA_DESIGN: "Design",
  PREVIEW_DEPLOYMENT: "Preview",
};

// External link type colors
export const EXTERNAL_LINK_TYPE_COLORS: Record<
  string,
  { bg: string; text: string }
> = {
  PULL_REQUEST: {
    bg: "bg-cyan-100 dark:bg-cyan-900/50",
    text: "text-cyan-700 dark:text-cyan-300",
  },
  FIGMA_DESIGN: {
    bg: "bg-purple-100 dark:bg-purple-900/50",
    text: "text-purple-700 dark:text-purple-300",
  },
  PREVIEW_DEPLOYMENT: {
    bg: "bg-slate-100 dark:bg-slate-800",
    text: "text-slate-700 dark:text-slate-300",
  },
};

// Issue icon
export const ISSUE_ICON: React.ElementType = AlertCircleIcon;
