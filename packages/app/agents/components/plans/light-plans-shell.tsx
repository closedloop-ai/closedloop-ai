"use client";

import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { CheckIcon, ClipboardListIcon, HistoryIcon, XIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export const LightPlanConfirmationState = {
  NeedsConfirmation: "needs-confirmation",
  NotRequired: "not-required",
  Confirmed: "confirmed",
  Rejected: "rejected",
} as const;

export type LightPlanConfirmationState =
  (typeof LightPlanConfirmationState)[keyof typeof LightPlanConfirmationState];

export type LightPlanVersion = {
  id: string;
  versionNumber: number;
  authorType?: string | null;
  captureMethod?: string | null;
  createdAt?: string | null;
  contentMarkdown?: string | null;
};

export type LightPlan = {
  id: string;
  title?: string | null;
  source?: string | null;
  harness?: string | null;
  captureMethod?: string | null;
  sourceStatus: string;
  confirmationState: LightPlanConfirmationState;
  statusLabel: string;
  latestContent?: string | null;
  versionCount: number;
  filePath?: string | null;
  sourceLogPath?: string | null;
  confidence?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type LightPlansSurfaceCapabilities = {
  projectControls?: boolean;
  teamControls?: boolean;
};

/** Identifies the caller-owned plan action currently waiting to settle. */
export type LightPlanPendingAction = {
  planId: string;
  action: "confirm" | "reject";
};

/** Caller-owned error state for a failed plan action. */
export type LightPlanActionError = {
  planId: string;
  action: "confirm" | "reject";
  message: string;
};

export type LightPlansShellProps = {
  plans: LightPlan[];
  selectedPlan: LightPlan | null;
  selectedPlanId: string | null;
  versions?: LightPlanVersion[];
  isLoading?: boolean;
  isError?: boolean;
  isVersionsLoading?: boolean;
  isVersionsError?: boolean;
  showVersions?: boolean;
  disabledActionPlanIds?: readonly string[];
  pendingAction?: LightPlanPendingAction | null;
  actionError?: LightPlanActionError | null;
  surfaceCapabilities?: LightPlansSurfaceCapabilities;
  projectControls?: ReactNode;
  teamControls?: ReactNode;
  onSelectPlan: (id: string) => void;
  onToggleVersions: () => void;
  onConfirmPlan: (id: string) => void | Promise<void>;
  onRejectPlan: (id: string) => void | Promise<void>;
};

const lightPlansGridStyle = {
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 28rem), 1fr))",
} satisfies CSSProperties;

/**
 * Portable light-plan review shell. Callers own data loading, selection, and
 * mutations; this component only renders already-projected plan state.
 */
export function LightPlansShell({
  plans,
  selectedPlan,
  selectedPlanId,
  versions = [],
  isLoading = false,
  isError = false,
  isVersionsLoading = false,
  isVersionsError = false,
  showVersions = false,
  disabledActionPlanIds = [],
  pendingAction = null,
  actionError = null,
  surfaceCapabilities,
  projectControls,
  teamControls,
  onSelectPlan,
  onToggleVersions,
  onConfirmPlan,
  onRejectPlan,
}: Readonly<LightPlansShellProps>) {
  const showProjectControls =
    surfaceCapabilities?.projectControls === true && projectControls;
  const showTeamControls =
    surfaceCapabilities?.teamControls === true && teamControls;

  if (isLoading) {
    return (
      <div className="grid gap-4" style={lightPlansGridStyle}>
        <Card>
          <CardContent className="space-y-3 p-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 p-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground text-sm">
          Plans are temporarily unavailable.
        </CardContent>
      </Card>
    );
  }

  if (plans.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            className="py-20"
            icon={ClipboardListIcon}
            title="No plans captured yet"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {(showProjectControls || showTeamControls) && (
        <div className="flex flex-wrap gap-2">
          {showProjectControls}
          {showTeamControls}
        </div>
      )}
      <div
        className="grid gap-4"
        data-testid="light-plans-content-grid"
        style={lightPlansGridStyle}
      >
        <Card>
          <CardHeader>
            <CardTitle>Plans ({plans.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[70vh] divide-y overflow-auto">
              {plans.map((plan) => (
                <PlanListButton
                  key={plan.id}
                  onSelectPlan={onSelectPlan}
                  plan={plan}
                  selected={plan.id === selectedPlanId}
                />
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          {selectedPlan ? (
            <>
              <PlanDetail
                actionError={actionError}
                disabledActionPlanIds={disabledActionPlanIds}
                onConfirmPlan={onConfirmPlan}
                onRejectPlan={onRejectPlan}
                pendingAction={pendingAction}
                plan={selectedPlan}
              />
              {selectedPlan.versionCount > 0 && (
                <Button
                  className="gap-1"
                  onClick={onToggleVersions}
                  size="sm"
                  variant="outline"
                >
                  <HistoryIcon className="h-4 w-4" />
                  {showVersions ? "Hide" : "Show"} Versions (
                  {selectedPlan.versionCount})
                </Button>
              )}
              {showVersions && (
                <VersionHistory
                  isError={isVersionsError}
                  isLoading={isVersionsLoading}
                  versions={versions}
                />
              )}
            </>
          ) : (
            <Card>
              <CardContent className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                Select a plan to view details
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Resolves the persisted status plus stale confirmation bit into the single
 * action-state source consumed by the light-plan shell.
 */
export function resolveLightPlanConfirmationState(
  sourceStatus: string,
  needsConfirmation: boolean
): LightPlanConfirmationState {
  const normalizedStatus = sourceStatus.toLowerCase();
  if (normalizedStatus === LightPlanConfirmationState.Confirmed) {
    return LightPlanConfirmationState.Confirmed;
  }
  if (normalizedStatus === LightPlanConfirmationState.Rejected) {
    return LightPlanConfirmationState.Rejected;
  }
  if (needsConfirmation) {
    return LightPlanConfirmationState.NeedsConfirmation;
  }
  return LightPlanConfirmationState.NotRequired;
}

export function getLightPlanStatusLabel(
  sourceStatus: string,
  confirmationState: LightPlanConfirmationState
): string {
  if (confirmationState === LightPlanConfirmationState.NeedsConfirmation) {
    return "Needs confirmation";
  }
  if (confirmationState === LightPlanConfirmationState.Confirmed) {
    return "confirmed";
  }
  if (confirmationState === LightPlanConfirmationState.Rejected) {
    return "rejected";
  }
  return sourceStatus;
}

function PlanListButton({
  plan,
  selected,
  onSelectPlan,
}: {
  plan: LightPlan;
  selected: boolean;
  onSelectPlan: (id: string) => void;
}) {
  return (
    <button
      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
        selected ? "bg-muted" : ""
      }`}
      onClick={() => onSelectPlan(plan.id)}
      type="button"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">{getPlanTitle(plan)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <StatusBadge plan={plan} />
          <MetadataBadge value={formatConfidence(plan.confidence)} />
          <MetadataBadge value={plan.captureMethod} />
          <MetadataBadge value={plan.harness} />
        </div>
      </div>
      <span className="shrink-0 text-muted-foreground text-xs">
        {formatLightPlanDate(plan.createdAt)}
      </span>
    </button>
  );
}

function PlanDetail({
  plan,
  disabledActionPlanIds,
  actionError,
  pendingAction,
  onConfirmPlan,
  onRejectPlan,
}: {
  plan: LightPlan;
  disabledActionPlanIds: readonly string[];
  actionError: LightPlanActionError | null;
  pendingAction: LightPlanPendingAction | null;
  onConfirmPlan: (id: string) => void | Promise<void>;
  onRejectPlan: (id: string) => void | Promise<void>;
}) {
  const showActions =
    plan.confirmationState === LightPlanConfirmationState.NeedsConfirmation;
  const pendingActionName =
    pendingAction?.planId === plan.id ? pendingAction.action : null;
  const actionErrorMessage =
    actionError?.planId === plan.id ? actionError.message : null;
  const actionsDisabled =
    disabledActionPlanIds.includes(plan.id) || pendingActionName !== null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="break-words font-semibold text-lg">
            {getPlanTitle(plan)}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <StatusBadge plan={plan} />
            <MetadataText label="Source" value={plan.source} />
            <MetadataText label="Harness" value={plan.harness} />
            <MetadataText label="Capture" value={plan.captureMethod} />
            <MetadataText
              label="Confidence"
              value={formatConfidence(plan.confidence)}
            />
          </div>
        </div>
        <div className="grid gap-1 text-muted-foreground text-xs sm:grid-cols-2">
          <MetadataText
            label="Created"
            value={formatLightPlanDate(plan.createdAt)}
          />
          <MetadataText
            label="Updated"
            value={formatLightPlanDate(plan.updatedAt)}
          />
          <MetadataText label="File" mono value={plan.filePath} />
          <MetadataText label="Source log" mono value={plan.sourceLogPath} />
        </div>
        {showActions && (
          <div className="flex flex-wrap gap-2">
            <Button
              aria-busy={pendingActionName === "confirm"}
              className="gap-1"
              disabled={actionsDisabled}
              onClick={() => onConfirmPlan(plan.id)}
              size="sm"
            >
              <CheckIcon className="h-4 w-4" />
              {pendingActionName === "confirm" ? "Confirming" : "Confirm"}
            </Button>
            <Button
              aria-busy={pendingActionName === "reject"}
              className="gap-1"
              disabled={actionsDisabled}
              onClick={() => onRejectPlan(plan.id)}
              size="sm"
              variant="outline"
            >
              <XIcon className="h-4 w-4" />
              {pendingActionName === "reject" ? "Rejecting" : "Reject"}
            </Button>
          </div>
        )}
        {actionErrorMessage && (
          <p className="text-destructive text-sm" role="alert">
            {actionErrorMessage}
          </p>
        )}
        <PlainTextBlock
          content={plan.latestContent}
          emptyLabel="No plan content captured."
        />
      </CardContent>
    </Card>
  );
}

function VersionHistory({
  versions,
  isError,
  isLoading,
}: {
  versions: LightPlanVersion[];
  isError: boolean;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Version History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Version history is temporarily unavailable for this plan.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Version History</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {versions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No version rows loaded for this plan.
          </p>
        ) : (
          versions.map((version) => (
            <div className="space-y-2 rounded-md border p-3" key={version.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">
                    v{version.versionNumber}
                  </span>
                  <MetadataBadge value={version.authorType} />
                  <MetadataBadge value={version.captureMethod} />
                </div>
                <span className="text-muted-foreground text-xs">
                  {formatLightPlanDate(version.createdAt)}
                </span>
              </div>
              <PlainTextBlock
                content={version.contentMarkdown}
                emptyLabel="No content captured for this version."
                small
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function PlainTextBlock({
  content,
  emptyLabel,
  small = false,
}: {
  content?: string | null;
  emptyLabel: string;
  small?: boolean;
}) {
  const text = content?.trim();
  if (!text) {
    return <p className="text-muted-foreground text-sm">{emptyLabel}</p>;
  }

  return (
    <pre
      className={`max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 font-sans leading-relaxed ${
        small ? "text-xs" : "text-sm"
      }`}
    >
      {content}
    </pre>
  );
}

function StatusBadge({ plan }: { plan: LightPlan }) {
  const variant = getStatusBadgeVariant(plan.confirmationState);
  return (
    <Badge className="text-[10px]" variant={variant}>
      {plan.statusLabel}
    </Badge>
  );
}

function MetadataBadge({ value }: { value?: string | null }) {
  if (!value) {
    return null;
  }
  return (
    <Badge className="text-[10px]" variant="outline">
      {value}
    </Badge>
  );
}

function MetadataText({
  label,
  value,
  mono = false,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  if (!value) {
    return null;
  }
  return (
    <span className={mono ? "break-all font-mono" : "break-words"}>
      {label}: {value}
    </span>
  );
}

function getStatusBadgeVariant(
  confirmationState: LightPlanConfirmationState
): "default" | "destructive" | "outline" {
  if (confirmationState === LightPlanConfirmationState.Confirmed) {
    return "default";
  }
  if (confirmationState === LightPlanConfirmationState.Rejected) {
    return "destructive";
  }
  return "outline";
}

function getPlanTitle(plan: LightPlan): string {
  const title = plan.title?.trim();
  return title ? title : "Untitled plan";
}

function formatLightPlanDate(value: string | null | undefined): string {
  return formatDateTimeOrFallback(value, { fallback: "-" });
}

function formatConfidence(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}
