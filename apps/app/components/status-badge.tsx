"use client";

import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/issue";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import type {
  WorkstreamState,
  WorkstreamType,
} from "@repo/api/src/types/workstream";
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
}: Readonly<StatusBadgeProps>) {
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
const COLOR_PURPLE =
  "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800";

/**
 * PR status colors per PRD requirements (AC3.1):
 * - OPEN → blue (in progress)
 * - MERGED → green (success)
 * - CLOSED → red (failure/abandoned)
 */
export const prStatusColors: Record<string, string> = {
  OPEN: COLOR_PROGRESS,
  MERGED: COLOR_SUCCESS,
  CLOSED: COLOR_FAILURE,
};

/**
 * PR review decision colors per PRD requirements (AC3.2):
 * - APPROVED → green (success)
 * - CHANGES_REQUESTED → red (needs work)
 * - COMMENTED → yellow (feedback provided)
 * - DISMISSED → gray (inactive/cancelled)
 */
export const prReviewDecisionColors: Record<string, string> = {
  APPROVED: COLOR_SUCCESS,
  CHANGES_REQUESTED: COLOR_FAILURE,
  COMMENTED: COLOR_PENDING,
  DISMISSED: COLOR_INACTIVE,
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
export const artifactStatusColors: Record<ArtifactStatus, string> = {
  [ArtifactStatus.Draft]: "bg-muted text-muted-foreground border-muted",
  [ArtifactStatus.ReadyForReview]: COLOR_PENDING,
  [ArtifactStatus.InReview]:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  [ArtifactStatus.Approved]:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  [ArtifactStatus.Executed]: COLOR_SUCCESS,
  [ArtifactStatus.Obsolete]:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

export const artifactStatusLabels: Record<ArtifactStatus, string> = {
  [ArtifactStatus.Draft]: "Draft",
  [ArtifactStatus.ReadyForReview]: "Ready for Review",
  [ArtifactStatus.InReview]: "In Review",
  [ArtifactStatus.Approved]: "Approved",
  [ArtifactStatus.Executed]: "Executed",
  [ArtifactStatus.Obsolete]: "Obsolete",
};

export function ArtifactStatusBadge({
  status,
}: Readonly<{ status: ArtifactStatus }>) {
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
export const issueStatusColors: Record<IssueStatus, string> = {
  [IssueStatus.NotStarted]: "bg-muted text-muted-foreground border-muted",
  [IssueStatus.InProgress]:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  [IssueStatus.InReview]:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
  [IssueStatus.Completed]:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  [IssueStatus.Obsolete]:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
};

export const issueStatusLabels: Record<IssueStatus, string> = {
  [IssueStatus.NotStarted]: "Not Started",
  [IssueStatus.InProgress]: "In Progress",
  [IssueStatus.InReview]: "In Review",
  [IssueStatus.Completed]: "Completed",
  [IssueStatus.Obsolete]: "Obsolete",
};

export function IssueStatusBadge({
  status,
}: Readonly<{ status: IssueStatus }>) {
  const displayStatus = issueStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        issueStatusColors[status] ?? issueStatusColors.NOT_STARTED
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

// Issue priority colors
export const issuePriorityColors: Record<Priority, string> = {
  [Priority.Low]:
    "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700",
  [Priority.Medium]:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  [Priority.High]:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  [Priority.Urgent]:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
};

export const issuePriorityLabels: Record<Priority, string> = {
  [Priority.Low]: "Low",
  [Priority.Medium]: "Medium",
  [Priority.High]: "High",
  [Priority.Urgent]: "Urgent",
};

export function IssuePriorityBadge({
  priority,
}: Readonly<{ priority: Priority }>) {
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
export const workstreamStateColors: Record<WorkstreamState, string> = {
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

const workstreamStateLabels: Record<WorkstreamState, string> = {
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

export function WorkstreamStateBadge({
  state,
}: Readonly<{ state: WorkstreamState }>) {
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
export const workstreamTypeColors: Record<WorkstreamType, string> = {
  FEATURE_DELIVERY:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  BUG_FIX:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  TECH_DEBT:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  SPIKE:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
};

const workstreamTypeLabels: Record<WorkstreamType, string> = {
  FEATURE_DELIVERY: "Feature",
  BUG_FIX: "Bug Fix",
  TECH_DEBT: "Tech Debt",
  SPIKE: "Spike",
};

export function WorkstreamTypeBadge({
  type,
}: Readonly<{ type: WorkstreamType }>) {
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

// Loop status colors
export const loopStatusColors: Record<LoopStatus, string> = {
  [LoopStatus.Pending]: COLOR_PENDING,
  [LoopStatus.Claimed]: COLOR_PENDING,
  [LoopStatus.Running]: COLOR_PROGRESS,
  [LoopStatus.Completed]: COLOR_SUCCESS,
  [LoopStatus.Failed]: COLOR_FAILURE,
  [LoopStatus.Cancelled]: COLOR_INACTIVE,
  [LoopStatus.TimedOut]: COLOR_FAILURE,
};

const loopStatusLabels: Record<LoopStatus, string> = {
  [LoopStatus.Pending]: "Pending",
  [LoopStatus.Claimed]: "Claimed",
  [LoopStatus.Running]: "Running",
  [LoopStatus.Completed]: "Completed",
  [LoopStatus.Failed]: "Failed",
  [LoopStatus.Cancelled]: "Cancelled",
  [LoopStatus.TimedOut]: "Timed Out",
};

export function LoopStatusBadge({ status }: Readonly<{ status: LoopStatus }>) {
  const displayStatus = loopStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        loopStatusColors[status] ?? loopStatusColors.PENDING
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

// Loop command colors
export const loopCommandColors: Record<LoopCommand, string> = {
  [LoopCommand.Plan]: COLOR_PURPLE,
  [LoopCommand.Execute]: COLOR_PROGRESS,
  [LoopCommand.Chat]: COLOR_PENDING,
  [LoopCommand.Explore]:
    "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-400 dark:border-teal-800",
  [LoopCommand.RequestChanges]: COLOR_PENDING,
  [LoopCommand.Decompose]: COLOR_PURPLE,
  [LoopCommand.GeneratePrd]: COLOR_PURPLE,
};

const loopCommandLabels: Record<LoopCommand, string> = {
  [LoopCommand.Plan]: "Plan",
  [LoopCommand.Execute]: "Execute",
  [LoopCommand.Chat]: "Chat",
  [LoopCommand.Explore]: "Explore",
  [LoopCommand.RequestChanges]: "Request Changes",
  [LoopCommand.Decompose]: "Decompose",
  [LoopCommand.GeneratePrd]: "Generate PRD",
};

export function LoopCommandBadge({
  command,
}: Readonly<{ command: LoopCommand }>) {
  const displayCommand = loopCommandLabels[command] ?? command;
  return (
    <Badge
      className={cn(
        "font-medium",
        loopCommandColors[command] ?? loopCommandColors.EXECUTE
      )}
      variant="outline"
    >
      {displayCommand}
    </Badge>
  );
}
