"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { FeatureStatus } from "@repo/api/src/types/feature";
import {
  LoopCommand,
  LoopErrorCode,
  LoopStatus,
} from "@repo/api/src/types/loop";
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

const COLOR_SUCCESS = "bg-success/10 text-success-foreground border-success/30";
const COLOR_FAILURE =
  "bg-destructive/10 text-destructive-foreground border-destructive/30";
const COLOR_PROGRESS = "bg-info/10 text-info-foreground border-info/30";
const COLOR_PENDING = "bg-warning/10 text-warning-foreground border-warning/30";
const COLOR_INACTIVE = "bg-muted text-muted-foreground border-muted";
const COLOR_AI = "bg-ai/10 text-ai-foreground border-ai/30";

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
  [ArtifactStatus.InReview]: COLOR_PENDING,
  [ArtifactStatus.Approved]: COLOR_SUCCESS,
  [ArtifactStatus.Executed]: COLOR_SUCCESS,
  [ArtifactStatus.Obsolete]: COLOR_INACTIVE,
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

// Feature status colors
export const featureStatusColors: Record<FeatureStatus, string> = {
  [FeatureStatus.NotStarted]: "bg-muted text-muted-foreground border-muted",
  [FeatureStatus.InProgress]: COLOR_PROGRESS,
  [FeatureStatus.InReview]: COLOR_PENDING,
  [FeatureStatus.Completed]: COLOR_SUCCESS,
  [FeatureStatus.Obsolete]: COLOR_INACTIVE,
};

export const featureStatusLabels: Record<FeatureStatus, string> = {
  [FeatureStatus.NotStarted]: "Not Started",
  [FeatureStatus.InProgress]: "In Progress",
  [FeatureStatus.InReview]: "In Review",
  [FeatureStatus.Completed]: "Completed",
  [FeatureStatus.Obsolete]: "Obsolete",
};

export function FeatureStatusBadge({
  status,
}: Readonly<{ status: FeatureStatus }>) {
  const displayStatus = featureStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        featureStatusColors[status] ?? featureStatusColors.NOT_STARTED
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

// Feature priority colors
export const featurePriorityColors: Record<Priority, string> = {
  [Priority.Low]: COLOR_INACTIVE,
  [Priority.Medium]: COLOR_PROGRESS,
  [Priority.High]: COLOR_PENDING,
  [Priority.Urgent]: COLOR_FAILURE,
};

export const featurePriorityLabels: Record<Priority, string> = {
  [Priority.Low]: "Low",
  [Priority.Medium]: "Medium",
  [Priority.High]: "High",
  [Priority.Urgent]: "Urgent",
};

export function FeaturePriorityBadge({
  priority,
}: Readonly<{ priority: Priority }>) {
  const displayPriority = featurePriorityLabels[priority] ?? priority;
  return (
    <Badge
      className={cn(
        "font-medium",
        featurePriorityColors[priority] ?? featurePriorityColors.LOW
      )}
      variant="outline"
    >
      {displayPriority}
    </Badge>
  );
}

// Workstream state colors
export const workstreamStateColors: Record<WorkstreamState, string> = {
  INITIATED: COLOR_PROGRESS,
  REQUIREMENTS_GENERATING: COLOR_AI,
  REQUIREMENTS_PENDING_APPROVAL: COLOR_PENDING,
  DESIGN_IN_PROGRESS: COLOR_AI,
  DESIGN_PENDING_APPROVAL: COLOR_PENDING,
  IMPLEMENTATION_PLANNING: COLOR_AI,
  IMPLEMENTATION_IN_PROGRESS: COLOR_PROGRESS,
  IMPLEMENTATION_PENDING_REVIEW: COLOR_PENDING,
  CODE_REVIEW_RUNNING: COLOR_AI,
  CODE_REVIEW_PENDING_APPROVAL: COLOR_PENDING,
  VISUAL_QA_RUNNING: COLOR_AI,
  VISUAL_QA_PENDING_APPROVAL: COLOR_PENDING,
  MERGING: COLOR_PROGRESS,
  DEPLOYED: COLOR_SUCCESS,
  COMPLETED: COLOR_SUCCESS,
  BLOCKED: COLOR_FAILURE,
  CANCELLED: COLOR_INACTIVE,
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
  FEATURE_DELIVERY: COLOR_PROGRESS,
  BUG_FIX: COLOR_FAILURE,
  TECH_DEBT: COLOR_PENDING,
  SPIKE: COLOR_AI,
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

export const loopErrorCodeLabels: Partial<Record<LoopErrorCode, string>> = {
  [LoopErrorCode.NoWorkProduced]: "No output produced",
  [LoopErrorCode.ContextLimitExceeded]: "Context limit exceeded",
  [LoopErrorCode.PlanStateUnavailable]: "Plan state unavailable",
};

export const loopErrorCodeColors: Partial<Record<LoopErrorCode, string>> = {
  [LoopErrorCode.NoWorkProduced]: COLOR_PENDING,
  [LoopErrorCode.ContextLimitExceeded]: COLOR_FAILURE,
  [LoopErrorCode.PlanStateUnavailable]: COLOR_FAILURE,
};

export function LoopStatusBadge({
  status,
  errorCode,
}: Readonly<{ status: LoopStatus; errorCode?: LoopErrorCode }>) {
  const ghostLoopFlag = useFeatureFlag("ghost-loop-ux");
  const ghostLoopUx = ghostLoopFlag?.enabled;

  const showErrorCode =
    ghostLoopUx &&
    status === LoopStatus.Failed &&
    errorCode !== undefined &&
    loopErrorCodeLabels[errorCode] !== undefined;

  const displayStatus = showErrorCode
    ? loopErrorCodeLabels[errorCode!]
    : (loopStatusLabels[status] ?? status);

  const colorClass = showErrorCode
    ? loopErrorCodeColors[errorCode!]
    : (loopStatusColors[status] ?? loopStatusColors[LoopStatus.Pending]);

  return (
    <Badge className={cn("font-medium", colorClass)} variant="outline">
      {displayStatus}
    </Badge>
  );
}

// Loop command colors
export const loopCommandColors: Record<LoopCommand, string> = {
  [LoopCommand.Plan]: COLOR_AI,
  [LoopCommand.Execute]: COLOR_PROGRESS,
  [LoopCommand.Chat]: COLOR_PENDING,
  [LoopCommand.Explore]: COLOR_AI,
  [LoopCommand.RequestChanges]: COLOR_PENDING,
  [LoopCommand.Decompose]: COLOR_AI,
  [LoopCommand.EvaluatePrd]: COLOR_AI,
  [LoopCommand.GeneratePrd]: COLOR_AI,
  [LoopCommand.EvaluatePlan]: COLOR_AI,
  [LoopCommand.EvaluateCode]: COLOR_AI,
  [LoopCommand.RequestPrdChanges]: COLOR_PENDING,
};

const loopCommandLabels: Record<LoopCommand, string> = {
  [LoopCommand.Plan]: "Plan",
  [LoopCommand.Execute]: "Execute",
  [LoopCommand.Chat]: "Chat",
  [LoopCommand.Explore]: "Explore",
  [LoopCommand.RequestChanges]: "Request Changes",
  [LoopCommand.Decompose]: "Decompose",
  [LoopCommand.EvaluatePrd]: "Evaluate PRD",
  [LoopCommand.GeneratePrd]: "Generate PRD",
  [LoopCommand.EvaluatePlan]: "Evaluate Plan",
  [LoopCommand.EvaluateCode]: "Evaluate PR",
  [LoopCommand.RequestPrdChanges]: "Request PRD Changes",
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
