"use client";

import { ISSUE_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { Badge } from "@repo/design-system/components/ui/badge";
import type { ToneLabelVariant } from "@repo/design-system/components/ui/tone-label";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { cn } from "@repo/design-system/lib/utils";
import { LoopCommand, LoopStatus } from "@closedloop-ai/loops-api/commands";
import { Priority } from "@closedloop-ai/loops-api/common";
import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import {
  LoopErrorCode,
  LoopErrorCodeSchema,
} from "@closedloop-ai/loops-api/error-codes";
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

// Issue (subtype = FEATURE) delivery-lifecycle vocabulary (PRD-495). Distinct
// from the Document maps above — no longer an alias.
export const issueStatusColors: Record<IssueStatus, string> = {
  [IssueStatus.Triage]: COLOR_AI,
  [IssueStatus.Backlog]: "bg-muted text-muted-foreground border-muted",
  [IssueStatus.Todo]: COLOR_PENDING,
  [IssueStatus.InProgress]: COLOR_PROGRESS,
  [IssueStatus.InReview]: COLOR_PROGRESS,
  [IssueStatus.Blocked]: COLOR_FAILURE,
  [IssueStatus.Done]: COLOR_SUCCESS,
  [IssueStatus.Canceled]: COLOR_INACTIVE,
};

// Labels are owned by project-constants (single source of truth); re-exported
// here so the badge and its consumers keep one import surface. Colors above are
// badge-specific tokens and intentionally distinct from the icon/text colors in
// project-constants. (PRD-495 review: dedupe the duplicated label strings.)
export const issueStatusLabels = ISSUE_STATUS_LABELS;

export function IssueStatusBadge({
  status,
}: Readonly<{ status: IssueStatus }>) {
  const displayStatus = issueStatusLabels[status] ?? status;
  return (
    <Badge
      className={cn(
        "font-medium",
        issueStatusColors[status] ?? issueStatusColors[IssueStatus.Backlog]
      )}
      variant="outline"
    >
      {displayStatus}
    </Badge>
  );
}

export const issuePriorityColors: Record<Priority, string> = {
  [Priority.Low]: COLOR_PROGRESS,
  [Priority.Medium]: COLOR_PENDING,
  [Priority.High]: COLOR_FAILURE,
  [Priority.Urgent]: COLOR_FAILURE,
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
        issuePriorityColors[priority] ?? issuePriorityColors[Priority.Low]
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
  // `string`, not `LoopErrorCode`: the producer side (`LoopError.code`, and the
  // `error` JSON column behind it) is an open string, so a newer runner can
  // persist a code this client has never heard of. Binding the prop to the
  // closed union would only have forced a cast at the call site and hidden that
  // -- the unknown code is narrowed below instead.
  errorCode?: string;
  ghostLoopUx?: boolean;
}>) {
  const showErrorCode =
    ghostLoopUx && status === LoopStatus.Failed && errorCode !== undefined;
  const friendlyErrorCode = showErrorCode ? errorCode : undefined;

  // `resolveFriendlyError` already tolerates an unknown code (it falls back to a
  // generic failure template), but the color map is keyed by the closed union,
  // so narrow through the schema rather than index it with an arbitrary string.
  const knownErrorCode = friendlyErrorCode
    ? LoopErrorCodeSchema.safeParse(friendlyErrorCode)
    : undefined;

  const displayStatus = friendlyErrorCode
    ? resolveFriendlyError({ code: friendlyErrorCode }).title
    : (loopStatusLabels[status] ?? status);

  const colorClass = friendlyErrorCode
    ? ((knownErrorCode?.success
        ? loopErrorCodeColors[knownErrorCode.data]
        : undefined) ?? loopStatusColors[LoopStatus.Failed])
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

// FEA-3968: one command→tone SSOT. Each tone carries BOTH the filled-badge
// className and its text-only sibling, so the two can never drift — there is no
// second hand-maintained 14-entry map. `LoopCommandBadge` reads `.badge` and
// `LoopCommandLabel` reads `.labelVariant` off the SAME entry.
//
// FEA-4035: the text half is no longer a `text-*` literal, it is a variant name
// from the shared `Badge`/`ToneLabel` vocabulary, so `LoopCommandLabel` renders
// through the `ToneLabel` primitive instead of a bespoke span with its own color
// map. `ToneLabel` resolves each of these to the SAME `text-*` utility this map
// used to spell out (`ai` → `text-ai-foreground`, `info` →
// `text-info-foreground`, `warning` → `text-warning-foreground`), asserted in
// `__tests__/loop-command-label.test.tsx`, so no label's color moves.
//
// The BADGE half deliberately stays a `COLOR_*` className rather than the
// matching `badgeVariants` variant: the two are NOT the same treatment. This
// surface's `COLOR_PROGRESS` is `bg-info/10 … border-info/30` against
// `badgeVariants.info`'s `bg-info/12 … border-info/25`, and its text reads the
// `-foreground` token where the badge variant reads the fill token. Repointing
// it would visibly restyle every loop badge in the product — a perceivable
// change needing its own gate, not a consolidation. Only the label, whose
// utilities already match exactly, moves onto the shared primitive here.
type LoopCommandTone = { badge: string; labelVariant: ToneLabelVariant };

const LOOP_COMMAND_TONE_AI: LoopCommandTone = {
  badge: COLOR_AI,
  labelVariant: "ai",
};
const LOOP_COMMAND_TONE_PROGRESS: LoopCommandTone = {
  badge: COLOR_PROGRESS,
  labelVariant: "info",
};
const LOOP_COMMAND_TONE_PENDING: LoopCommandTone = {
  badge: COLOR_PENDING,
  labelVariant: "warning",
};

const loopCommandTones: Record<LoopCommand, LoopCommandTone> = {
  [LoopCommand.Plan]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.Execute]: LOOP_COMMAND_TONE_PROGRESS,
  [LoopCommand.Chat]: LOOP_COMMAND_TONE_PENDING,
  [LoopCommand.Explore]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.RequestChanges]: LOOP_COMMAND_TONE_PENDING,
  [LoopCommand.RequestPrdChanges]: LOOP_COMMAND_TONE_PENDING,
  [LoopCommand.Decompose]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.EvaluatePrd]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.GeneratePrd]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.EvaluatePlan]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.EvaluateCode]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.EvaluateFeature]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.Bootstrap]: LOOP_COMMAND_TONE_AI,
  [LoopCommand.Manual]: LOOP_COMMAND_TONE_PENDING,
};

function loopCommandTone(command: LoopCommand): LoopCommandTone {
  return loopCommandTones[command] ?? loopCommandTones[LoopCommand.Execute];
}

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
  [LoopCommand.EvaluateFeature]: "Evaluate Issue",
  [LoopCommand.Bootstrap]: "Bootstrap",
  [LoopCommand.Manual]: "Manual",
};

export function LoopCommandBadge({
  command,
}: Readonly<{ command: LoopCommand }>) {
  const displayCommand = loopCommandLabels[command] ?? command;
  return (
    <Badge
      className={cn("font-medium", loopCommandTone(command).badge)}
      variant="outline"
    >
      {displayCommand}
    </Badge>
  );
}

/**
 * Plain colored text label for a loop Command — the low-emphasis sibling of
 * {@link LoopCommandBadge} (FEA-3968). Command is low-variance categorical
 * metadata (often "Manual" on every row), so the table renders it as a plain
 * colored string; the color is the text half of the SAME per-command tone the
 * badge uses (`loopCommandTone`), so the label and badge can never drift.
 */
export function LoopCommandLabel({
  command,
}: Readonly<{ command: LoopCommand }>) {
  const displayCommand = loopCommandLabels[command] ?? command;
  return (
    <ToneLabel variant={loopCommandTone(command).labelVariant}>
      {displayCommand}
    </ToneLabel>
  );
}
