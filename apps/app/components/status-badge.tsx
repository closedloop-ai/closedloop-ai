"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
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
  "bg-destructive/10 text-destructive border-destructive/30";
const COLOR_PROGRESS = "bg-info/10 text-info-foreground border-info/30";
const COLOR_PENDING = "bg-warning/10 text-warning-foreground border-warning/30";
const COLOR_INACTIVE = "bg-muted text-muted-foreground border-muted";
const COLOR_AI = "bg-ai/10 text-ai-foreground border-ai/30";

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
export const artifactStatusColors: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "bg-muted text-muted-foreground border-muted",
  [DocumentStatus.InProgress]: COLOR_PROGRESS,
  [DocumentStatus.InReview]: COLOR_PROGRESS,
  [DocumentStatus.Approved]: COLOR_PROGRESS,
  [DocumentStatus.Executed]: COLOR_PROGRESS,
  [DocumentStatus.Done]: COLOR_SUCCESS,
  [DocumentStatus.Obsolete]: COLOR_INACTIVE,
};

export const artifactStatusLabels: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "Draft",
  [DocumentStatus.InProgress]: "In Progress",
  [DocumentStatus.InReview]: "In Review",
  [DocumentStatus.Approved]: "Approved",
  [DocumentStatus.Executed]: "Executed",
  [DocumentStatus.Done]: "Done",
  [DocumentStatus.Obsolete]: "Obsolete",
};

export function DocumentStatusBadge({
  status,
}: Readonly<{ status: DocumentStatus }>) {
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
export const PrdStatusBadge = DocumentStatusBadge;

// Alias for Implementation Plans
export const ImplementationPlanStatusBadge = DocumentStatusBadge;

// Feature status badge — feature-typed documents share DocumentStatus.
export const featureStatusColors = artifactStatusColors;
export const featureStatusLabels = artifactStatusLabels;
export const FeatureStatusBadge = DocumentStatusBadge;

// Feature priority colors
export const featurePriorityColors: Record<Priority, string> = {
  [Priority.Low]: COLOR_PROGRESS,
  [Priority.Medium]: COLOR_PENDING,
  [Priority.High]: COLOR_FAILURE,
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

export const loopErrorCodeColors: Partial<Record<LoopErrorCode, string>> = {
  [LoopErrorCode.NoWorkProduced]: COLOR_PENDING,
  [LoopErrorCode.ContextLimitExceeded]: COLOR_FAILURE,
  [LoopErrorCode.PlanStateUnavailable]: COLOR_FAILURE,
  [LoopErrorCode.StaleDispatch]: COLOR_FAILURE,
  [LoopErrorCode.RunnerError]: COLOR_FAILURE,
};

export function LoopStatusBadge({
  status,
  errorCode,
}: Readonly<{ status: LoopStatus; errorCode?: LoopErrorCode }>) {
  const ghostLoopFlag = useFeatureFlag("ghost-loop-ux");
  const ghostLoopUx = ghostLoopFlag?.enabled;

  const showErrorCode =
    ghostLoopUx && status === LoopStatus.Failed && errorCode !== undefined;
  const friendlyErrorCode = showErrorCode ? errorCode : undefined;

  const displayStatus = friendlyErrorCode
    ? resolveFriendlyError({ code: friendlyErrorCode }).title
    : (loopStatusLabels[status] ?? status);

  const colorClass = friendlyErrorCode
    ? (loopErrorCodeColors[friendlyErrorCode] ??
      loopStatusColors[LoopStatus.Failed])
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
  [LoopCommand.RequestPrdChanges]: COLOR_PENDING,
  [LoopCommand.Decompose]: COLOR_AI,
  [LoopCommand.EvaluatePrd]: COLOR_AI,
  [LoopCommand.GeneratePrd]: COLOR_AI,
  [LoopCommand.EvaluatePlan]: COLOR_AI,
  [LoopCommand.EvaluateCode]: COLOR_AI,
  [LoopCommand.EvaluateFeature]: COLOR_AI,
  [LoopCommand.Bootstrap]: COLOR_AI,
  [LoopCommand.Manual]: COLOR_PENDING,
};

const loopCommandLabels: Record<LoopCommand, string> = {
  [LoopCommand.Plan]: "Plan",
  [LoopCommand.Execute]: "Execute",
  [LoopCommand.Chat]: "Chat",
  [LoopCommand.Explore]: "Explore",
  [LoopCommand.RequestChanges]: "Request Changes",
  [LoopCommand.RequestPrdChanges]: "Request PRD Changes",
  [LoopCommand.Decompose]: "Decompose",
  [LoopCommand.EvaluatePrd]: "Evaluate PRD",
  [LoopCommand.GeneratePrd]: "Generate PRD",
  [LoopCommand.EvaluatePlan]: "Evaluate Plan",
  [LoopCommand.EvaluateCode]: "Evaluate PR",
  [LoopCommand.EvaluateFeature]: "Evaluate Feature",
  [LoopCommand.Bootstrap]: "Bootstrap",
  [LoopCommand.Manual]: "Manual",
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
