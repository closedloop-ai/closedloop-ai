"use client";

import { FEATURE_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import { LoopCommand, LoopStatus } from "@closedloop-ai/loops-api/commands";
import { Priority } from "@closedloop-ai/loops-api/common";
import { DocumentStatus, FeatureStatus } from "@closedloop-ai/loops-api/document";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import {
  LoopEventType,
  type LoopEventType as LoopEventTypeType,
} from "@closedloop-ai/loops-api/events";
import { resolveFriendlyError } from "@closedloop-ai/loops-api/friendly-error";

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

// Document (PRD / IMPLEMENTATION_PLAN / TEMPLATE) status vocabulary (PRD-495).
export const artifactStatusColors: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "bg-muted text-muted-foreground border-muted",
  [DocumentStatus.InReview]: COLOR_PROGRESS,
  [DocumentStatus.ChangesRequested]: COLOR_PENDING,
  [DocumentStatus.Approved]: COLOR_SUCCESS,
  [DocumentStatus.Executed]: COLOR_SUCCESS,
  [DocumentStatus.Obsolete]: COLOR_INACTIVE,
};

export const artifactStatusLabels: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "Draft",
  [DocumentStatus.InReview]: "In Review",
  [DocumentStatus.ChangesRequested]: "Changes Requested",
  [DocumentStatus.Approved]: "Approved",
  [DocumentStatus.Executed]: "Executed",
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
        artifactStatusColors[status] ??
          artifactStatusColors[DocumentStatus.Draft]
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

export const PrdStatusBadge = DocumentStatusBadge;
export const ImplementationPlanStatusBadge = DocumentStatusBadge;

// Feature (subtype = FEATURE) delivery-lifecycle vocabulary (PRD-495). Distinct
// from the Document maps above — no longer an alias.
export const featureStatusColors: Record<FeatureStatus, string> = {
  [FeatureStatus.Triage]: COLOR_AI,
  [FeatureStatus.Backlog]: "bg-muted text-muted-foreground border-muted",
  [FeatureStatus.Todo]: COLOR_PENDING,
  [FeatureStatus.InProgress]: COLOR_PROGRESS,
  [FeatureStatus.InReview]: COLOR_PROGRESS,
  [FeatureStatus.Blocked]: COLOR_FAILURE,
  [FeatureStatus.Done]: COLOR_SUCCESS,
  [FeatureStatus.Canceled]: COLOR_INACTIVE,
};

// Labels are owned by project-constants (single source of truth); re-exported
// here so the badge and its consumers keep one import surface. Colors above are
// badge-specific tokens and intentionally distinct from the icon/text colors in
// project-constants. (PRD-495 review: dedupe the duplicated label strings.)
export const featureStatusLabels = FEATURE_STATUS_LABELS;

export function FeatureStatusBadge({
  status,
}: Readonly<{ status: FeatureStatus }>) {
  const displayStatus = featureStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        featureStatusColors[status] ??
          featureStatusColors[FeatureStatus.Backlog]
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

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
        featurePriorityColors[priority] ?? featurePriorityColors[Priority.Low]
      )}
      variant="outline"
    >
      {displayPriority}
    </Badge>
  );
}

export const loopStatusColors: Record<LoopStatus, string> = {
  [LoopStatus.Pending]: COLOR_PENDING,
  [LoopStatus.Claimed]: COLOR_PENDING,
  [LoopStatus.Running]: COLOR_PROGRESS,
  [LoopStatus.Completed]: COLOR_SUCCESS,
  [LoopStatus.Failed]: COLOR_FAILURE,
  [LoopStatus.Cancelled]: COLOR_INACTIVE,
  [LoopStatus.TimedOut]: COLOR_FAILURE,
  [LoopStatus.Blocked]: COLOR_PENDING,
};

const loopStatusLabels: Record<LoopStatus, string> = {
  [LoopStatus.Pending]: "Pending",
  [LoopStatus.Claimed]: "Claimed",
  [LoopStatus.Running]: "Running",
  [LoopStatus.Completed]: "Completed",
  [LoopStatus.Failed]: "Failed",
  [LoopStatus.Cancelled]: "Cancelled",
  [LoopStatus.TimedOut]: "Timed Out",
  [LoopStatus.Blocked]: "Blocked",
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
  ghostLoopUx = false,
}: Readonly<{
  status: LoopStatus;
  errorCode?: LoopErrorCode;
  ghostLoopUx?: boolean;
}>) {
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

// Loop display status derived from stream + polled events (see
// loop-progress-panel.tsx). Kept here next to its color/label maps so both
// stay exhaustive against this union; consumers import the type from here.
export type DisplayStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "DISCONNECTED";

export const displayStatusColors: Record<DisplayStatus, string> = {
  PENDING: COLOR_PENDING,
  RUNNING: COLOR_PROGRESS,
  COMPLETED: COLOR_SUCCESS,
  FAILED: COLOR_FAILURE,
  CANCELLED: COLOR_INACTIVE,
  DISCONNECTED: COLOR_INACTIVE,
};

export const displayStatusLabels: Record<DisplayStatus, string> = {
  PENDING: "Pending",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  DISCONNECTED: "Disconnected",
};

export const loopEventTypeColors: Record<LoopEventTypeType, string> = {
  [LoopEventType.Started]: COLOR_PROGRESS,
  [LoopEventType.Output]: COLOR_INACTIVE,
  [LoopEventType.Progress]: COLOR_PROGRESS,
  [LoopEventType.ToolCall]: COLOR_AI,
  [LoopEventType.ArtifactCreated]: COLOR_SUCCESS,
  [LoopEventType.SupportBundleUploaded]: COLOR_PROGRESS,
  [LoopEventType.Completed]: COLOR_SUCCESS,
  [LoopEventType.Error]: COLOR_FAILURE,
  [LoopEventType.Cancelled]: COLOR_PENDING,
  [LoopEventType.TokenRefreshed]: COLOR_INACTIVE,
  [LoopEventType.TokensCleared]: COLOR_INACTIVE,
  [LoopEventType.ReapReversed]: COLOR_PENDING,
};

export const loopEventTypeLabels: Record<LoopEventTypeType, string> = {
  [LoopEventType.Started]: "Started",
  [LoopEventType.Output]: "Output",
  [LoopEventType.Progress]: "Progress",
  [LoopEventType.ToolCall]: "Tool Call",
  [LoopEventType.ArtifactCreated]: "Artifact Created",
  [LoopEventType.SupportBundleUploaded]: "Support Uploaded",
  [LoopEventType.Completed]: "Completed",
  [LoopEventType.Error]: "Error",
  [LoopEventType.Cancelled]: "Cancelled",
  [LoopEventType.TokenRefreshed]: "Token Refreshed",
  [LoopEventType.TokensCleared]: "Tokens Cleared",
  [LoopEventType.ReapReversed]: "Reap Reversed",
};

export function LoopEventTypeBadge({
  eventType,
}: Readonly<{ eventType: LoopEventTypeType }>) {
  return (
    <Badge
      className={cn(
        "font-medium",
        loopEventTypeColors[eventType] ??
          loopEventTypeColors[LoopEventType.Started]
      )}
      variant="outline"
    >
      {loopEventTypeLabels[eventType] ?? eventType}
    </Badge>
  );
}

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

export const loopCommandLabels: Record<LoopCommand, string> = {
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
        loopCommandColors[command] ?? loopCommandColors[LoopCommand.Execute]
      )}
      variant="outline"
    >
      {displayCommand}
    </Badge>
  );
}
