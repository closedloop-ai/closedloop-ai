"use client";

import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
  BranchViewSyncPresentationState,
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import { DocumentType } from "@repo/api/src/types/document";
import type { BranchViewSyncControl } from "@repo/app/documents/hooks/use-branch-view";
import type { PullRequestLifecycle as PullRequestLifecycleValue } from "@repo/app/github/lib/pull-request-lifecycle";
import {
  getPullRequestLifecycle,
  PullRequestLifecycle,
  PullRequestLifecycleLabels,
} from "@repo/app/github/lib/pull-request-lifecycle";
import { DOCUMENT_TYPE_ICONS } from "@repo/app/projects/lib/project-constants";
import { getUserInitials } from "@repo/app/shared/lib/user-utils";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Link } from "@repo/navigation/link";
import {
  BoxIcon,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  GitPullRequestIcon,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useMemo } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import type { BranchViewData } from "../types";
import { getLifecycleSyncDisplayLabel } from "./branch-view-sync-display";

const PlanIcon = DOCUMENT_TYPE_ICONS[DocumentType.ImplementationPlan];

const PLAN_TITLE_PREFIX = "Implementation plan: ";

function formatPlanBadgeLabel(title: string | null): string {
  if (!title) {
    return "Plan";
  }
  const trimmed = title.trimStart();
  return trimmed.startsWith(PLAN_TITLE_PREFIX)
    ? trimmed.slice(PLAN_TITLE_PREFIX.length).trimStart()
    : trimmed;
}

type PrStatus =
  | "checks_failing"
  | "checks_pending"
  | "changes_requested"
  | "commented"
  | "review_required"
  | "approved"
  | "checks_passing";

function getPrStatus(
  reviewDecision: BranchViewData["reviewDecision"],
  checksStatus: BranchViewData["checksStatus"]
): PrStatus | null {
  if (checksStatus === ChecksStatus.Failing) {
    return "checks_failing";
  }
  if (checksStatus === ChecksStatus.Pending) {
    return "checks_pending";
  }
  if (reviewDecision === ReviewDecision.ChangesRequested) {
    return "changes_requested";
  }
  if (reviewDecision === null) {
    return "review_required";
  }
  if (reviewDecision === ReviewDecision.Approved) {
    return "approved";
  }
  if (reviewDecision === ReviewDecision.Commented) {
    return "commented";
  }
  if (checksStatus === ChecksStatus.Passing) {
    return "checks_passing";
  }
  return null;
}

const PR_STATUS_LABELS: Record<PrStatus, string> = {
  checks_failing: "Checks failing",
  checks_pending: "Checks pending",
  changes_requested: "Changes requested",
  commented: "Commented",
  review_required: "Review required",
  approved: "Approved",
  checks_passing: "Checks passing",
};

type BranchPropertiesBarProps = {
  data: BranchViewData;
  syncControl: BranchViewSyncControl;
};

/**
 * Metadata bar under the title. Design: Properties Inline -- only bottom border,
 * no outer box. Chips in order: plan (if linked), feature (link to issue), You (if author), one PR status (if PR). Same chip style: rounded 6px, bg, 1px border, py-1.5 px-2, gap-2, text 12px font-medium.
 */
export function BranchPropertiesBar({
  data,
  syncControl,
}: Readonly<BranchPropertiesBarProps>) {
  const orgSlug = useOrgSlug();
  const { data: currentUser } = useCurrentUser();
  const ownerInitials = currentUser
    ? getUserInitials(currentUser.firstName, currentUser.lastName) || "You"
    : "You";
  const prLifecycle =
    data.currentPullRequest || data.prState
      ? getPullRequestLifecycle({
          isDraft: data.isDraft,
          prState: data.prState,
        })
      : null;
  const showActivePrStatus = isActivePullRequestLifecycle(prLifecycle);
  const prStatus = showActivePrStatus
    ? getPrStatus(data.reviewDecision, data.checksStatus)
    : null;
  const checksTrigger = getChecksTriggerPresentation(data);
  let prStatusChip: React.ReactNode = null;
  if (prStatus && isChecksOwnedPrStatus(prStatus) && data.checks) {
    prStatusChip = (
      <ChecksDropdownChip
        checks={data.checks}
        icon={<PrStatusIcon status={prStatus} />}
        label={PR_STATUS_LABELS[prStatus]}
      />
    );
  } else if (prStatus) {
    prStatusChip = (
      <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
        <PrStatusIcon status={prStatus} />
        <span className="font-medium text-foreground text-xs">
          {PR_STATUS_LABELS[prStatus]}
        </span>
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-border border-b py-3">
      {data.producedByPlanSlug ? (
        <Link
          className="inline-flex h-8 max-w-[240px] items-center gap-2 truncate rounded-md border border-border bg-background px-2 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent"
          href={`/${orgSlug}/implementation-plans/${data.producedByPlanSlug}`}
          title={data.producedByPlanTitle ?? undefined}
        >
          <PlanIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">
            {formatPlanBadgeLabel(data.producedByPlanTitle)}
          </span>
        </Link>
      ) : null}
      {data.featureSlug && data.featureTitle ? (
        <Link
          className="inline-flex h-8 max-w-[240px] items-center gap-2 truncate rounded-md border border-border bg-background px-2 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent"
          href={`/${orgSlug}/features/${data.featureSlug}`}
          title={data.featureTitle}
        >
          <BoxIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">{data.featureTitle}</span>
        </Link>
      ) : null}
      {data.isAuthor ? (
        <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
          <Avatar className="h-4 w-4 shrink-0">
            {currentUser?.avatarUrl ? (
              <AvatarImage alt="You" src={currentUser.avatarUrl} />
            ) : null}
            <AvatarFallback className="text-[10px]">
              {ownerInitials}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-foreground text-xs">You</span>
        </span>
      ) : null}
      {prLifecycle ? (
        <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
          <PrLifecycleIcon lifecycle={prLifecycle} />
          <span className="font-medium text-foreground text-xs">
            {PullRequestLifecycleLabels[prLifecycle]}
          </span>
        </span>
      ) : null}
      {prStatusChip}
      {showActivePrStatus &&
      data.checks &&
      !(prStatus && isChecksOwnedPrStatus(prStatus)) ? (
        <ChecksDropdownChip
          checks={data.checks}
          icon={<PrStatusIcon status={checksTrigger.status} />}
          label={checksTrigger.label}
        />
      ) : null}
      <SyncFreshnessChip data={data} syncControl={syncControl} />
    </div>
  );
}

type SyncFreshnessChipProps = Pick<
  BranchPropertiesBarProps,
  "data" | "syncControl"
>;

function SyncFreshnessChip({
  data,
  syncControl,
}: Readonly<SyncFreshnessChipProps>) {
  const syncState = data.syncState;
  const isRefreshing =
    syncControl.isBranchSyncPending ||
    syncControl.isCommentsSyncPending ||
    syncState?.inProgress ||
    syncState?.presentation === BranchViewSyncPresentationState.Refreshing;
  const label = isRefreshing
    ? "Refreshing"
    : getLifecycleSyncDisplayLabel({
        isBranchSyncPending: syncControl.isBranchSyncPending,
        syncRetryState: syncControl.syncRetryState,
        syncState,
      });
  if (!label) {
    return null;
  }
  const isRefreshDisabled = isRefreshing || Boolean(syncControl.syncRetryState);

  return (
    <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1.5">
      <span className="px-1 font-medium text-muted-foreground text-xs">
        {label}
      </span>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <Button
            aria-label="Refresh PR status and comments from GitHub"
            className="h-6 w-6 shrink-0 p-0"
            disabled={isRefreshDisabled}
            onClick={syncControl.refreshBranch}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RefreshCw
              className={
                isRefreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
              }
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Refresh PR status and comments from GitHub</p>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

function PrLifecycleIcon({
  lifecycle,
}: {
  lifecycle: PullRequestLifecycleValue;
}) {
  if (lifecycle === PullRequestLifecycle.Merged) {
    return <CheckCircle2 className="h-4 w-4 text-success" />;
  }
  if (lifecycle === PullRequestLifecycle.Closed) {
    return <XCircle className="h-4 w-4 text-muted-foreground" />;
  }
  return <GitPullRequestIcon className="h-4 w-4 text-foreground" />;
}

function PrStatusIcon({ status }: { status: PrStatus }) {
  if (status === "checks_failing" || status === "changes_requested") {
    return <XCircle className="h-4 w-4 text-destructive" />;
  }
  if (status === "approved" || status === "checks_passing") {
    return <CheckCircle2 className="h-4 w-4 text-success" />;
  }
  return <Clock className="h-4 w-4 text-warning" />;
}

function ChecksDropdownChip({
  checks,
  icon,
  label,
}: {
  checks: NonNullable<BranchViewData["checks"]>;
  icon: React.ReactNode;
  label: string;
}) {
  const rows = useMemo(
    () =>
      checks.items
        .map((item, index) => ({
          item,
          index,
          severity: getCheckSeverity(item),
        }))
        .sort(
          (left, right) =>
            left.severity - right.severity || left.index - right.index
        ),
    [checks.items]
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={
            label === "Checks details" ? "Checks details" : `${label} details`
          }
          className="inline-flex h-8 max-w-[240px] items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent"
          type="button"
        >
          {icon}
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(28rem,calc(100vw-2rem))]"
      >
        {checks.providerState ===
        BranchViewChecksProviderState.ProviderUnavailable ? (
          <DropdownMenuItem disabled>
            <span className="truncate text-muted-foreground">
              Check details unavailable
            </span>
          </DropdownMenuItem>
        ) : null}
        {checks.providerState === BranchViewChecksProviderState.NoChecks &&
        rows.length === 0 ? (
          <DropdownMenuItem disabled>
            <span className="truncate text-muted-foreground">
              No checks configured
            </span>
          </DropdownMenuItem>
        ) : null}
        {rows.map(({ item }) => (
          <DropdownMenuItem asChild={!!item.targetUrl} key={item.id}>
            {item.targetUrl ? (
              <a
                className="flex min-w-0 items-center justify-between gap-3"
                href={item.targetUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <CheckRowContent item={item} />
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            ) : (
              <span className="flex min-w-0 items-center justify-between gap-3">
                <CheckRowContent item={item} />
              </span>
            )}
          </DropdownMenuItem>
        ))}
        {checks.truncated ? (
          <DropdownMenuItem disabled>
            <span className="truncate text-muted-foreground">
              Showing {checks.items.length} of {checks.totalCount} checks
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CheckRowContent({
  item,
}: {
  item: NonNullable<BranchViewData["checks"]>["items"][number];
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <CheckItemIcon item={item} />
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {getCheckStateLabel(item)}
      </span>
    </span>
  );
}

function CheckItemIcon({
  item,
}: {
  item: NonNullable<BranchViewData["checks"]>["items"][number];
}) {
  const severity = getCheckSeverity(item);
  if (severity === 0) {
    return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  if (severity === 2) {
    return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  }
  return <Clock className="h-3.5 w-3.5 text-warning" />;
}

function isChecksOwnedPrStatus(status: PrStatus): boolean {
  return (
    status === "checks_failing" ||
    status === "checks_pending" ||
    status === "checks_passing"
  );
}

function isActivePullRequestLifecycle(
  lifecycle: PullRequestLifecycleValue | null
): boolean {
  return (
    lifecycle === PullRequestLifecycle.Open ||
    lifecycle === PullRequestLifecycle.Draft
  );
}

function getChecksTriggerPresentation(data: BranchViewData): {
  status: PrStatus;
  label: string;
} {
  if (data.checksStatus === ChecksStatus.Failing) {
    return {
      status: "checks_failing",
      label: PR_STATUS_LABELS.checks_failing,
    };
  }
  if (data.checksStatus === ChecksStatus.Pending) {
    return {
      status: "checks_pending",
      label: PR_STATUS_LABELS.checks_pending,
    };
  }
  if (data.checksStatus === ChecksStatus.Passing) {
    return {
      status: "checks_passing",
      label: PR_STATUS_LABELS.checks_passing,
    };
  }
  return { status: "checks_pending", label: "Checks details" };
}

function getCheckStateLabel(
  item: NonNullable<BranchViewData["checks"]>["items"][number]
): string {
  const conclusion = item.conclusion?.trim();
  if (conclusion) {
    return toTitleCase(conclusion);
  }
  const status = item.status?.trim();
  if (status) {
    return toTitleCase(status);
  }
  return item.kind === BranchViewCheckKind.CheckRun ? "Unknown" : "Status";
}

function getCheckSeverity(
  item: NonNullable<BranchViewData["checks"]>["items"][number]
): number {
  const state = item.conclusion ?? item.status ?? "";
  if (
    state === "FAILURE" ||
    state === "ERROR" ||
    state === "CANCELLED" ||
    state === "TIMED_OUT"
  ) {
    return 0;
  }
  if (state === "SUCCESS" || state === "PASSING" || state === "COMPLETED") {
    return 2;
  }
  return 1;
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
