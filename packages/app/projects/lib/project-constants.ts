import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import {
  GITHUB_PR_STATE_LABELS,
  GitHubPRState,
} from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import { BoxIcon, FileIcon, FileTextIcon, ListCheckIcon } from "lucide-react";
import type * as React from "react";

// Priority display constants moved to @repo/app/shared/lib/priority-constants
// (unified across all entities, keyed by the shared Priority enum).

// ---------------------------------------------------------------------------
// Status display config (PRD-495). Documents (PRD/IMPLEMENTATION_PLAN/TEMPLATE)
// and Features (FEATURE) carry disjoint status vocabularies. Single-artifact
// editors and per-type pickers use the per-vocabulary maps; the mixed
// documents table (which renders both kinds) uses the combined ARTIFACT_STATUS_LABELS
// map for lookup since the two sets overlap only on IN_REVIEW (identically).
// ---------------------------------------------------------------------------

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "Draft",
  [DocumentStatus.InReview]: "In Review",
  [DocumentStatus.ChangesRequested]: "Changes Requested",
  [DocumentStatus.Approved]: "Approved",
  [DocumentStatus.Executed]: "Executed",
  [DocumentStatus.Obsolete]: "Obsolete",
};

// Document/Feature status → icon mapping now lives in the dedicated
// DocumentStatusIcon / FeatureStatusIcon components (each owns its own glyph per
// status). For status-grouped or mixed surfaces where the artifact type is not
// singular, use ArtifactStatusIcon. See
// @repo/app/documents/components/{document,feature,artifact}-status-icon.

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  [FeatureStatus.Triage]: "Triage",
  [FeatureStatus.Backlog]: "Backlog",
  [FeatureStatus.Todo]: "Todo",
  [FeatureStatus.InProgress]: "In Progress",
  [FeatureStatus.InReview]: "In Review",
  [FeatureStatus.Blocked]: "Blocked",
  [FeatureStatus.Done]: "Done",
  [FeatureStatus.Canceled]: "Canceled",
};

/**
 * Combined label lookup map for the mixed documents table, which renders
 * Documents and Features in one list. The two vocabularies overlap only on
 * `IN_REVIEW` (identical label), so a flat status-keyed lookup is unambiguous.
 * Use this for read-only display by status string; use the per-vocabulary maps
 * above wherever the artifact type is known and options must be scoped.
 * Status *icons* are rendered by ArtifactStatusIcon (or the per-type
 * DocumentStatusIcon / FeatureStatusIcon), not a map.
 */
export const ARTIFACT_STATUS_LABELS: Record<string, string> = {
  ...DOCUMENT_STATUS_LABELS,
  ...FEATURE_STATUS_LABELS,
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

// Branch (Pull Request) artifact status labels/icons.
export const BRANCH_STATUS_LABELS: Record<GitHubPRState, string> =
  GITHUB_PR_STATE_LABELS;

export const BRANCH_STATUS_TO_ICON: Record<GitHubPRState, StatusIconStatus> = {
  [GitHubPRState.Open]: "in-progress",
  [GitHubPRState.Merged]: "complete",
  [GitHubPRState.Closed]: "wont-do",
};
