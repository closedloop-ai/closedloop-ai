import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import type { ProjectPriority } from "@repo/api/src/types/organization";
import {
  AlertCircleIcon,
  BookOpenIcon,
  BugIcon,
  ClipboardListIcon,
  FileTextIcon,
  GitBranchIcon,
  MapIcon,
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

// Artifact subtype icons
export const ARTIFACT_SUBTYPE_ICONS: Record<string, React.ElementType> &
  Partial<Record<ArtifactSubtype, React.ElementType>> = {
  // Legacy ProjectArtifactSubtype values
  PROJECT_BRIEF: BookOpenIcon,
  DESIGNS: PaintbrushIcon,
  FEATURE_BRANCHES: GitBranchIcon,
  // ArtifactSubtype values
  PRD: FileTextIcon,
  FIGMA_DESIGN: PaintbrushIcon,
  IMPLEMENTATION_PLAN: ClipboardListIcon,
  IMPLEMENTATION_STRATEGY: MapIcon,
  ISSUE: AlertCircleIcon,
  BUG: BugIcon,
  TEMPLATE: FileTextIcon,
  PULL_REQUEST: GitBranchIcon,
};

// Artifact subtype labels for display
export const ARTIFACT_SUBTYPE_LABELS: Record<string, string> &
  Partial<Record<ArtifactSubtype, string>> = {
  // Legacy ProjectArtifactSubtype values
  PROJECT_BRIEF: "Brief",
  DESIGNS: "Designs",
  FEATURE_BRANCHES: "Branches",
  // ArtifactSubtype values
  PRD: "PRD",
  FIGMA_DESIGN: "Designs",
  IMPLEMENTATION_PLAN: "Impl Plan",
  IMPLEMENTATION_STRATEGY: "Implementation Strategy",
  ISSUE: "Issue",
  BUG: "Bug",
  TEMPLATE: "Template",
  PULL_REQUEST: "Branches",
};

// Artifact subtype colors for pills (bg + text)
export const ARTIFACT_SUBTYPE_COLORS: Record<
  string,
  { bg: string; text: string }
> &
  Partial<Record<ArtifactSubtype, { bg: string; text: string }>> = {
  // Legacy ProjectArtifactSubtype values
  PROJECT_BRIEF: {
    bg: "bg-slate-100 dark:bg-slate-800",
    text: "text-slate-700 dark:text-slate-300",
  },
  DESIGNS: {
    bg: "bg-purple-100 dark:bg-purple-900/50",
    text: "text-purple-700 dark:text-purple-300",
  },
  FEATURE_BRANCHES: {
    bg: "bg-cyan-100 dark:bg-cyan-900/50",
    text: "text-cyan-700 dark:text-cyan-300",
  },
  // ArtifactSubtype values
  PRD: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  FIGMA_DESIGN: {
    bg: "bg-purple-100 dark:bg-purple-900/50",
    text: "text-purple-700 dark:text-purple-300",
  },
  IMPLEMENTATION_PLAN: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  IMPLEMENTATION_STRATEGY: {
    bg: "bg-teal-100 dark:bg-teal-900/50",
    text: "text-teal-700 dark:text-teal-300",
  },
  ISSUE: {
    bg: "bg-orange-100 dark:bg-orange-900/50",
    text: "text-orange-700 dark:text-orange-300",
  },
  BUG: {
    bg: "bg-red-100 dark:bg-red-900/50",
    text: "text-red-700 dark:text-red-300",
  },
  TEMPLATE: {
    bg: "bg-indigo-100 dark:bg-indigo-900/50",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  PULL_REQUEST: {
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
