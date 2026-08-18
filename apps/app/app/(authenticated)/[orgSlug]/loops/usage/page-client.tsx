"use client";

import type { LoopUsageSummary } from "@repo/api/src/types/loop";
import {
  type LoopUsageFilters,
  useLoopUsage,
} from "@repo/app/loops/hooks/use-loops";
import { ApiError } from "@repo/app/shared/api/api-error";
import { loopCommandLabels } from "@repo/app/shared/components/status-badge";
import {
  formatCost,
  formatCurrencyWhole,
  formatNumber,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { AlertCircleIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  LoopUsageCommandTable,
  LoopUsageUserTable,
} from "./components/loop-usage-tables";
import {
  formatAsOf,
  getUsageScopeStartIso,
  parseUsageScope,
  USAGE_SCOPE_LABELS,
  USAGE_SCOPES,
  type UsageScope,
} from "./lib/usage-scope";

function formatCommand(command: string): string {
  return command
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function formatCommandLabel(command: string): string {
  return (
    loopCommandLabels[command as keyof typeof loopCommandLabels] ??
    formatCommand(command)
  );
}

function SummaryCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20" />
      </CardContent>
    </Card>
  );
}

function UsageErrorAlert({ isForbidden }: { isForbidden: boolean }) {
  return (
    <Alert data-testid="usage-error" variant="error">
      <AlertCircleIcon />
      <AlertTitle>
        {isForbidden
          ? "You don't have access to usage data"
          : "Failed to load usage data"}
      </AlertTitle>
      <AlertDescription>
        {isForbidden
          ? "Usage analytics are available to organization admins. Contact an admin if you need access."
          : "There was an error loading the usage dashboard. Please try refreshing the page."}
      </AlertDescription>
    </Alert>
  );
}

function SummaryCards({
  usage,
  scopeLabel,
}: {
  usage: LoopUsageSummary | undefined;
  scopeLabel: string;
}) {
  // FEA-1541: the headline cost is an accumulated usage total over the selected
  // window (not a unit rate), so the detail line names the window to remove the
  // "is this a rate or a total?" ambiguity the spec flagged.
  const windowNote = `accumulated over ${scopeLabel.toLowerCase()}`;
  return (
    <>
      <MetricCard
        label="Total Loops"
        value={formatNumber(usage?.totalLoops ?? 0)}
      />
      <MetricCard
        detail={`${formatNumber(usage?.totalTokensInput ?? 0)} tokens`}
        label="Input Tokens"
        value={formatTokenCount(usage?.totalTokensInput ?? 0)}
      />
      <MetricCard
        detail={`${formatNumber(usage?.totalTokensOutput ?? 0)} tokens`}
        label="Output Tokens"
        value={formatTokenCount(usage?.totalTokensOutput ?? 0)}
      />
      <MetricCard
        detail={`${formatNumber(usage?.totalCacheCreationTokens ?? 0)} write / ${formatNumber(usage?.totalCacheReadTokens ?? 0)} read`}
        label="Cache Tokens"
        value={formatTokenCount(
          (usage?.totalCacheCreationTokens ?? 0) +
            (usage?.totalCacheReadTokens ?? 0)
        )}
      />
      <MetricCard
        detail={windowNote}
        label="Estimated Cost"
        value={formatCurrencyWhole(usage?.totalEstimatedCost ?? 0)}
      />
    </>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function UsageDashboard({
  usage,
  isLoading,
  scopeLabel,
}: {
  usage: LoopUsageSummary | undefined;
  isLoading: boolean;
  scopeLabel: string;
}) {
  const commandRows = useMemo(
    () =>
      [...(usage?.byCommand ?? [])]
        .sort((a, b) => b.loopCount - a.loopCount)
        .map((row) => ({
          command: formatCommandLabel(row.command),
          loops: row.loopCount.toLocaleString(),
          input: formatTokenCount(row.tokensInput),
          output: formatTokenCount(row.tokensOutput),
          cost: formatCost(row.estimatedCost),
        })),
    [usage?.byCommand]
  );
  const userRows = useMemo(
    () =>
      [...(usage?.byUser ?? [])]
        .sort((a, b) => b.estimatedCost - a.estimatedCost)
        .map((row) => ({
          id: row.userId,
          name: row.userName,
          avatarUrl: row.userAvatarUrl,
          loops: row.loopCount.toLocaleString(),
          input: formatTokenCount(row.tokensInput),
          output: formatTokenCount(row.tokensOutput),
          cost: formatCost(row.estimatedCost),
        })),
    [usage?.byUser]
  );

  return (
    <>
      {/* Summary cards */}
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5"
        data-testid="usage-summary-grid"
      >
        {isLoading ? (
          <>
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
          </>
        ) : (
          <SummaryCards scopeLabel={scopeLabel} usage={usage} />
        )}
      </div>

      {/* Breakdown by command */}
      <Card>
        <CardHeader>
          <CardTitle>Breakdown by Command</CardTitle>
          <CardDescription>
            Accumulated token usage and estimated cost over{" "}
            {scopeLabel.toLowerCase()}, grouped by loop command type. These are
            usage totals, not per-token unit rates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableSkeleton />
          ) : (
            <LoopUsageCommandTable rows={commandRows} />
          )}
        </CardContent>
      </Card>

      {/* Breakdown by user */}
      <Card>
        <CardHeader>
          <CardTitle>Breakdown by User</CardTitle>
          <CardDescription>
            Accumulated token usage and estimated cost over{" "}
            {scopeLabel.toLowerCase()}, per team member. These are usage totals,
            not per-token unit rates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableSkeleton />
          ) : (
            <LoopUsageUserTable rows={userRows} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function LoopUsagePageClient() {
  const [scope, setScope] = useState<UsageScope>("30d");

  const filters: LoopUsageFilters = useMemo(
    () => ({
      startDate: getUsageScopeStartIso(scope),
    }),
    [scope]
  );

  const {
    data: usage,
    isLoading,
    isError,
    error,
    dataUpdatedAt,
  } = useLoopUsage(filters);
  const isForbidden = error instanceof ApiError && error.isForbidden();

  // "As of" stamp (AC-007.2): React Query's `dataUpdatedAt` is the epoch-ms
  // instant the currently-displayed payload was last successfully computed. It
  // advances on every fresh fetch — including an in-place scope switch
  // (AC-007.3) — so it is the authoritative freshness signal (0 until the first
  // success, which we treat as "not yet available").
  const asOf = dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null;

  const scopeLabel = USAGE_SCOPE_LABELS[scope];

  return (
    // ISS-4477: the Loops list (the Usage Dashboard's former entry point) is
    // retired, so this flag-gated route is now reached only by direct URL. Give
    // it the standard Header so it is not a doorless screen — the SidebarTrigger
    // and breadcrumb restore the way back out that the removed list page's chrome
    // used to provide.
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Usage" }]} suppressPageHeading />
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">
              Usage Dashboard
            </h1>
            <p className="text-muted-foreground">
              Token consumption and estimated costs for AI loops.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <AnalyticsRangeToggle
              onValueChange={(value) => setScope(parseUsageScope(value))}
              options={USAGE_SCOPES.map((value) => ({
                value,
                label: USAGE_SCOPE_LABELS[value],
              }))}
              value={scope}
            />
            {asOf && !isError ? (
              <p
                className="text-muted-foreground text-xs"
                data-testid="usage-as-of"
              >
                Showing {scopeLabel.toLowerCase()} · as of{" "}
                <time dateTime={asOf.toISOString()}>{formatAsOf(asOf)}</time>
              </p>
            ) : null}
          </div>
        </div>

        <Separator />

        {isError ? (
          <UsageErrorAlert isForbidden={isForbidden} />
        ) : (
          <UsageDashboard
            isLoading={isLoading}
            scopeLabel={scopeLabel}
            usage={usage}
          />
        )}
      </div>
    </div>
  );
}
