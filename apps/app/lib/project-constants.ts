import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { IssueStatus } from "@repo/api/src/types/issue";
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
export const ARTIFACT_STATUS_LABELS: Record<ArtifactStatus, string> = {
  [ArtifactStatus.Draft]: "Draft",
  [ArtifactStatus.InReview]: "In Review",
  [ArtifactStatus.Approved]: "Approved",
  [ArtifactStatus.Obsolete]: "Obsolete",
};

export const ARTIFACT_STATUS_COLORS: Record<ArtifactStatus, string> = {
  [ArtifactStatus.Draft]: "text-muted-foreground",
  [ArtifactStatus.InReview]: "text-yellow-600 dark:text-yellow-400",
  [ArtifactStatus.Approved]: "text-green-600 dark:text-green-400",
  [ArtifactStatus.Obsolete]: "text-muted-foreground",
};

// Artifact type icons
export const ARTIFACT_TYPE_ICONS: Record<ArtifactType, React.ElementType> = {
  [ArtifactType.Prd]: FileTextIcon,
  [ArtifactType.ImplementationPlan]: ClipboardListIcon,
  [ArtifactType.Template]: FileTextIcon,
};

// Artifact type labels for display
export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  [ArtifactType.Prd]: "PRD",
  [ArtifactType.ImplementationPlan]: "Implementation Plan",
  [ArtifactType.Template]: "Template",
};

// Artifact type colors for pills (bg + text)
export const ARTIFACT_TYPE_COLORS: Record<
  ArtifactType,
  { bg: string; text: string }
> = {
  [ArtifactType.Prd]: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  [ArtifactType.ImplementationPlan]: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  [ArtifactType.Template]: {
    bg: "bg-indigo-100 dark:bg-indigo-900/50",
    text: "text-indigo-700 dark:text-indigo-300",
  },
};

// Issue status labels and colors
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  [IssueStatus.NotStarted]: "Not Started",
  [IssueStatus.InProgress]: "In Progress",
  [IssueStatus.InReview]: "In Review",
  [IssueStatus.Completed]: "Completed",
  [IssueStatus.Obsolete]: "Obsolete",
};

export const ISSUE_STATUS_COLORS: Record<IssueStatus, string> = {
  [IssueStatus.NotStarted]: "text-muted-foreground",
  [IssueStatus.InProgress]: "text-blue-600 dark:text-blue-400",
  [IssueStatus.InReview]: "text-yellow-600 dark:text-yellow-400",
  [IssueStatus.Completed]: "text-green-600 dark:text-green-400",
  [IssueStatus.Obsolete]: "text-muted-foreground",
};

// External link type icons
export const EXTERNAL_LINK_TYPE_ICONS: Record<
  ExternalLinkType,
  React.ElementType
> = {
  [ExternalLinkType.PullRequest]: GitBranchIcon,
  [ExternalLinkType.FigmaDesign]: PaintbrushIcon,
  [ExternalLinkType.PreviewDeployment]: FileTextIcon,
};

// External link type labels
export const EXTERNAL_LINK_TYPE_LABELS: Record<ExternalLinkType, string> = {
  [ExternalLinkType.PullRequest]: "Pull Request",
  [ExternalLinkType.FigmaDesign]: "Design",
  [ExternalLinkType.PreviewDeployment]: "Preview",
};

// External link type colors
export const EXTERNAL_LINK_TYPE_COLORS: Record<
  ExternalLinkType,
  { bg: string; text: string }
> = {
  [ExternalLinkType.PullRequest]: {
    bg: "bg-cyan-100 dark:bg-cyan-900/50",
    text: "text-cyan-700 dark:text-cyan-300",
  },
  [ExternalLinkType.FigmaDesign]: {
    bg: "bg-purple-100 dark:bg-purple-900/50",
    text: "text-purple-700 dark:text-purple-300",
  },
  [ExternalLinkType.PreviewDeployment]: {
    bg: "bg-slate-100 dark:bg-slate-800",
    text: "text-slate-700 dark:text-slate-300",
  },
};

// Issue icon
export const ISSUE_ICON: React.ElementType = AlertCircleIcon;
