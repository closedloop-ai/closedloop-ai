"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";

type StatusBadgeProps = {
  status: string;
  colorMap: Record<string, string>;
  defaultStyle?: string;
  className?: string;
};

export function StatusBadge({
  status,
  colorMap,
  defaultStyle,
  className,
}: StatusBadgeProps) {
  return (
    <Badge
      className={cn(
        "font-medium",
        colorMap[status] ?? defaultStyle ?? colorMap[Object.keys(colorMap)[0]],
        className
      )}
      variant="outline"
    >
      {status}
    </Badge>
  );
}

const COLOR_SUCCESS =
  "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800";
const COLOR_FAILURE =
  "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800";
const COLOR_PROGRESS =
  "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800";
const COLOR_PENDING =
  "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800";
const COLOR_INACTIVE =
  "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700";

/**
 * PR status colors mapping to PRD requirements for AC3.1.
 * Separate from pullRequestStateColors - this maps specific status strings
 * (OPEN, MERGED, CLOSED) to semantic colors based on PRD acceptance criteria:
 * - OPEN → blue (in progress)
 * - MERGED → green (success)
 * - CLOSED → red (failure/abandoned)
 */
/**
 * Unified PR status colors per PRD requirements (AC3.1):
 * - OPEN → blue (in progress)
 * - MERGED → green (success)
 * - CLOSED → red (failure/abandoned)
 */
export const prStatusColors: Record<string, string> = {
  OPEN: COLOR_PROGRESS,
  MERGED: COLOR_SUCCESS,
  CLOSED: COLOR_FAILURE,
};

export const previewDeploymentStateColors: Record<string, string> = {
  READY: COLOR_SUCCESS,
  SUCCESS: COLOR_SUCCESS,
  IN_PROGRESS: COLOR_PROGRESS,
  BUILDING: COLOR_PROGRESS,
  PENDING: COLOR_PENDING,
  QUEUED: COLOR_PENDING,
  INACTIVE: COLOR_INACTIVE,
  FAILURE: COLOR_FAILURE,
  ERROR: COLOR_FAILURE,
};

// Pre-configured color maps for common use cases
export const artifactStatusColors: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground border-muted",
  REVIEW:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  APPROVED:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  ARCHIVED:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

export const artifactStatusLabels: Record<string, string> = {
  DRAFT: "Draft",
  REVIEW: "Review",
  APPROVED: "Approved",
  ARCHIVED: "Archived",
};

export function ArtifactStatusBadge({ status }: { status: string }) {
  const displayStatus = artifactStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        artifactStatusColors[status] ?? artifactStatusColors.DRAFT
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

// Alias for PRDs
export const PrdStatusBadge = ArtifactStatusBadge;

// Alias for Implementation Plans
export const ImplementationPlanStatusBadge = ArtifactStatusBadge;

// Issue status colors
export const issueStatusColors: Record<string, string> = {
  TODO: "bg-muted text-muted-foreground border-muted",
  IN_PROGRESS:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  IN_REVIEW:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  CLOSED:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
};

export const issueStatusLabels: Record<string, string> = {
  TODO: "Todo",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  CLOSED: "Closed",
};

export function IssueStatusBadge({ status }: Readonly<{ status: string }>) {
  const displayStatus = issueStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        issueStatusColors[status] ?? issueStatusColors.TODO
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

// Issue priority colors
export const issuePriorityColors: Record<string, string> = {
  LOW: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
  MEDIUM:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  HIGH: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  URGENT:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
};

export const issuePriorityLabels: Record<string, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

export function IssuePriorityBadge({
  priority,
}: Readonly<{ priority: string }>) {
  const displayPriority = issuePriorityLabels[priority] ?? priority;
  return (
    <Badge
      className={cn(
        "font-medium",
        issuePriorityColors[priority] ?? issuePriorityColors.LOW
      )}
      variant="outline"
    >
      {displayPriority}
    </Badge>
  );
}

// Workstream state colors
export const workstreamStateColors: Record<string, string> = {
  INITIATED:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  REQUIREMENTS_GENERATING:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  REQUIREMENTS_PENDING_APPROVAL:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  DESIGN_IN_PROGRESS:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  DESIGN_PENDING_APPROVAL:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  IMPLEMENTATION_PLANNING:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  IMPLEMENTATION_IN_PROGRESS:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  IMPLEMENTATION_PENDING_REVIEW:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  CODE_REVIEW_RUNNING:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  CODE_REVIEW_PENDING_APPROVAL:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  VISUAL_QA_RUNNING:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
  VISUAL_QA_PENDING_APPROVAL:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  MERGING:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  DEPLOYED:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  COMPLETED:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  BLOCKED:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  CANCELLED:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

const workstreamStateLabels: Record<string, string> = {
  INITIATED: "Initiated",
  REQUIREMENTS_GENERATING: "Generating",
  REQUIREMENTS_PENDING_APPROVAL: "Pending Approval",
  DESIGN_IN_PROGRESS: "In Progress",
  DESIGN_PENDING_APPROVAL: "Pending Approval",
  IMPLEMENTATION_PLANNING: "Planning",
  IMPLEMENTATION_IN_PROGRESS: "In Progress",
  IMPLEMENTATION_PENDING_REVIEW: "Pending Review",
  CODE_REVIEW_RUNNING: "Running",
  CODE_REVIEW_PENDING_APPROVAL: "Pending Approval",
  VISUAL_QA_RUNNING: "Running",
  VISUAL_QA_PENDING_APPROVAL: "Pending Approval",
  MERGING: "Merging",
  DEPLOYED: "Deployed",
  COMPLETED: "Completed",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",
};

export function WorkstreamStateBadge({ state }: { state: string }) {
  const displayState = workstreamStateLabels[state] ?? state;
  return (
    <Badge
      className={cn(
        "font-medium",
        workstreamStateColors[state] ?? workstreamStateColors.INITIATED
      )}
      variant="outline"
    >
      {displayState}
    </Badge>
  );
}

// Workstream type colors
export const workstreamTypeColors: Record<string, string> = {
  FEATURE_DELIVERY:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  BUG_FIX:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  TECH_DEBT:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  SPIKE:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
};

const workstreamTypeLabels: Record<string, string> = {
  FEATURE_DELIVERY: "Feature",
  BUG_FIX: "Bug Fix",
  TECH_DEBT: "Tech Debt",
  SPIKE: "Spike",
};

export function WorkstreamTypeBadge({ type }: { type: string }) {
  const displayType = workstreamTypeLabels[type] ?? type;
  return (
    <Badge
      className={cn(
        "font-medium",
        workstreamTypeColors[type] ?? workstreamTypeColors.FEATURE_DELIVERY
      )}
      variant="outline"
    >
      {displayType}
    </Badge>
  );
}
