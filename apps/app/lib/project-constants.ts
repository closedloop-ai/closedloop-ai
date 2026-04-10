import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import {
  BoxIcon,
  FileCode2Icon,
  FileIcon,
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
  [ArtifactStatus.InProgress]: "In Progress",
  [ArtifactStatus.InReview]: "In Review",
  [ArtifactStatus.Approved]: "Approved",
  [ArtifactStatus.Executed]: "Executed",
  [ArtifactStatus.Done]: "Done",
  [ArtifactStatus.Obsolete]: "Obsolete",
  /** @deprecated Migrated to IN_REVIEW */
  [ArtifactStatus.ReadyForReview]: "In Review",
};

export const ARTIFACT_STATUS_COLORS: Record<ArtifactStatus, string> = {
  [ArtifactStatus.Draft]: "text-muted-foreground",
  [ArtifactStatus.InProgress]: "text-blue-600 dark:text-blue-400",
  [ArtifactStatus.InReview]: "text-blue-600 dark:text-blue-400",
  [ArtifactStatus.Approved]: "text-blue-600 dark:text-blue-400",
  [ArtifactStatus.Executed]: "text-blue-600 dark:text-blue-400",
  [ArtifactStatus.Done]: "text-green-600 dark:text-green-400",
  [ArtifactStatus.Obsolete]: "text-muted-foreground",
  /** @deprecated Migrated to IN_REVIEW */
  [ArtifactStatus.ReadyForReview]: "text-blue-600 dark:text-blue-400",
};

export const ARTIFACT_STATUS_TO_ICON: Record<ArtifactStatus, StatusIconStatus> =
  {
    [ArtifactStatus.Draft]: "todo",
    [ArtifactStatus.InProgress]: "started",
    [ArtifactStatus.InReview]: "in-progress",
    [ArtifactStatus.Approved]: "in-review",
    [ArtifactStatus.Executed]: "executed",
    [ArtifactStatus.Done]: "complete",
    [ArtifactStatus.Obsolete]: "wont-do",
    /** @deprecated Migrated to IN_REVIEW */
    [ArtifactStatus.ReadyForReview]: "in-progress",
  };

// Artifact type icons
export const ARTIFACT_TYPE_ICONS: Record<ArtifactType, React.ElementType> = {
  [ArtifactType.Prd]: FileIcon,
  [ArtifactType.ImplementationPlan]: FileCode2Icon,
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

// Artifact type short badge labels (for compact displays like Context table)
export const ARTIFACT_TYPE_BADGE_LABELS: Record<ArtifactType, string> = {
  [ArtifactType.Prd]: "PRD",
  [ArtifactType.ImplementationPlan]: "Plan",
  [ArtifactType.Template]: "Template",
};

// Feature status labels and colors
export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  [FeatureStatus.Draft]: "Draft",
  [FeatureStatus.InProgress]: "In Progress",
  [FeatureStatus.InReview]: "In Review",
  [FeatureStatus.Approved]: "Approved",
  [FeatureStatus.Executed]: "Executed",
  [FeatureStatus.Done]: "Done",
  [FeatureStatus.Obsolete]: "Obsolete",
  /** @deprecated Migrated to DRAFT */
  [FeatureStatus.NotStarted]: "Draft",
  /** @deprecated Migrated to DONE */
  [FeatureStatus.Completed]: "Done",
};

export const FEATURE_STATUS_COLORS: Record<FeatureStatus, string> = {
  [FeatureStatus.Draft]: "text-muted-foreground",
  [FeatureStatus.InProgress]: "text-blue-600 dark:text-blue-400",
  [FeatureStatus.InReview]: "text-blue-600 dark:text-blue-400",
  [FeatureStatus.Approved]: "text-blue-600 dark:text-blue-400",
  [FeatureStatus.Executed]: "text-blue-600 dark:text-blue-400",
  [FeatureStatus.Done]: "text-green-600 dark:text-green-400",
  [FeatureStatus.Obsolete]: "text-muted-foreground",
  /** @deprecated Migrated to DRAFT */
  [FeatureStatus.NotStarted]: "text-muted-foreground",
  /** @deprecated Migrated to DONE */
  [FeatureStatus.Completed]: "text-green-600 dark:text-green-400",
};

export const FEATURE_STATUS_TO_ICON: Record<FeatureStatus, StatusIconStatus> = {
  [FeatureStatus.Draft]: "todo",
  [FeatureStatus.InProgress]: "started",
  [FeatureStatus.InReview]: "in-progress",
  [FeatureStatus.Approved]: "in-review",
  [FeatureStatus.Executed]: "executed",
  [FeatureStatus.Done]: "complete",
  [FeatureStatus.Obsolete]: "wont-do",
  /** @deprecated Migrated to DRAFT */
  [FeatureStatus.NotStarted]: "todo",
  /** @deprecated Migrated to DONE */
  [FeatureStatus.Completed]: "complete",
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

// External link type short badge labels (for compact displays like Context table)
export const EXTERNAL_LINK_TYPE_BADGE_LABELS: Record<ExternalLinkType, string> =
  {
    [ExternalLinkType.PullRequest]: "PR",
    [ExternalLinkType.FigmaDesign]: "Figma",
    [ExternalLinkType.PreviewDeployment]: "Preview",
  };

// Feature icon
export const FEATURE_ICON: React.ElementType = BoxIcon;

// Project status labels
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  [ProjectStatus.NotStarted]: "Not Started",
  [ProjectStatus.InProgress]: "In Progress",
  [ProjectStatus.Completed]: "Completed",
  [ProjectStatus.Archived]: "Archived",
};
