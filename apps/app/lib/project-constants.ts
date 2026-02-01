import type { ProjectPriority } from "@repo/api/src/types/organization";
import {
  AlertCircleIcon,
  BookOpenIcon,
  ClipboardListIcon,
  FileTextIcon,
  GitBranchIcon,
  PaintbrushIcon,
} from "lucide-react";
import type * as React from "react";
import type { ArtifactDisplayStatus } from "@/types/teams";

// Priority configuration
export const PRIORITY_LABELS: Record<ProjectPriority, string> = {
  NOT_SET: "Not Set",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

export const PRIORITY_COLORS: Record<ProjectPriority, string> = {
  NOT_SET: "text-muted-foreground",
  LOW: "text-blue-600 dark:text-blue-400",
  MEDIUM: "text-yellow-600 dark:text-yellow-400",
  HIGH: "text-red-600 dark:text-red-400",
};

// Artifact status configuration
export const ARTIFACT_STATUS_LABELS: Record<ArtifactDisplayStatus, string> = {
  WONT_DO: "Won't Do",
  COMPLETE: "Complete",
  NOT_STARTED: "Not Started",
  NOT_PUBLISHED: "Not Published",
};

export const ARTIFACT_STATUS_COLORS: Record<ArtifactDisplayStatus, string> = {
  WONT_DO: "text-muted-foreground",
  COMPLETE: "text-green-600 dark:text-green-400",
  NOT_STARTED: "text-muted-foreground",
  NOT_PUBLISHED: "text-yellow-600 dark:text-yellow-400",
};

// Artifact type icons
export const ARTIFACT_TYPE_ICONS: Record<string, React.ElementType> = {
  PROJECT_BRIEF: BookOpenIcon,
  PRD: FileTextIcon,
  DESIGNS: PaintbrushIcon,
  IMPLEMENTATION_PLAN: ClipboardListIcon,
  ISSUE: AlertCircleIcon,
  FEATURE_BRANCHES: GitBranchIcon,
};

// Artifact type labels for display
export const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  PROJECT_BRIEF: "Brief",
  PRD: "PRD",
  DESIGNS: "Designs",
  IMPLEMENTATION_PLAN: "Impl Plan",
  ISSUE: "Issue",
  FEATURE_BRANCHES: "Branches",
};

// Artifact type colors for pills (bg + text)
export const ARTIFACT_TYPE_COLORS: Record<
  string,
  { bg: string; text: string }
> = {
  PROJECT_BRIEF: {
    bg: "bg-slate-100 dark:bg-slate-800",
    text: "text-slate-700 dark:text-slate-300",
  },
  PRD: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  DESIGNS: {
    bg: "bg-purple-100 dark:bg-purple-900/50",
    text: "text-purple-700 dark:text-purple-300",
  },
  IMPLEMENTATION_PLAN: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  ISSUE: {
    bg: "bg-orange-100 dark:bg-orange-900/50",
    text: "text-orange-700 dark:text-orange-300",
  },
  FEATURE_BRANCHES: {
    bg: "bg-cyan-100 dark:bg-cyan-900/50",
    text: "text-cyan-700 dark:text-cyan-300",
  },
};

/**
 * Map API artifact status to display status
 */
export function mapArtifactStatusToDisplay(
  status: string
): ArtifactDisplayStatus {
  switch (status) {
    case "APPROVED":
      return "COMPLETE";
    case "DRAFT":
    case "REVIEW":
      return "NOT_PUBLISHED";
    case "ARCHIVED":
      return "WONT_DO";
    default:
      return "NOT_STARTED";
  }
}

/**
 * Map display status back to API artifact status
 */
export function mapDisplayStatusToArtifact(
  displayStatus: ArtifactDisplayStatus
): string {
  switch (displayStatus) {
    case "COMPLETE":
      return "APPROVED";
    case "NOT_PUBLISHED":
      return "DRAFT";
    case "WONT_DO":
      return "ARCHIVED";
    default:
      return "DRAFT";
  }
}
