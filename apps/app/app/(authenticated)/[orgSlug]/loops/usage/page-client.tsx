"use client";

import type { LoopUsageSummary } from "@repo/api/src/types/loop";
import {
  type LoopUsageFilters,
  useLoopUsage,
} from "@repo/app/loops/hooks/use-loops";
import { ApiError } from "@repo/app/shared/api/api-error";
import { loopCommandLabels } from "@repo/app/shared/components/status-badge";
import {
  DATE_RANGE_LABELS,
  type DateRange,
  formatCost,
  formatNumber,
  formatTokenCount,
  getStartDateForRange,
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
import {
  LoopUsageCommandTable,
  LoopUsageUserTable,
} from "./components/loop-usage-tables";

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

function SummaryCards({ usage }: { usage: LoopUsageSummary | undefined }) {
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
        label="Estimated Cost"
        value={formatCost(usage?.totalEstimatedCost ?? 0)}
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
}: {
  usage: LoopUsageSummary | undefined;
  isLoading: boolean;
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
          <SummaryCards usage={usage} />
        )}
      </div>

      {/* Breakdown by command */}
      <Card>
        <CardHeader>
          <CardTitle>Breakdown by Command</CardTitle>
          <CardDescription>
            Token usage and costs grouped by loop command type.
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
            Token usage and costs per team member.
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
  const [dateRange, setDateRange] = useState<DateRange>("30d");

  const filters: LoopUsageFilters = useMemo(
    () => ({
      startDate: getStartDateForRange(dateRange),
    }),
    [dateRange]
  );

  const { data: usage, isLoading, isError, error } = useLoopUsage(filters);
  const isForbidden = error instanceof ApiError && error.isForbidden();

  return (
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
        <AnalyticsRangeToggle
          onValueChange={(value) => setDateRange(value as DateRange)}
          options={Object.entries(DATE_RANGE_LABELS).map(([value, label]) => ({
            value,
            label,
          }))}
          value={dateRange}
        />
      </div>

      <Separator />

      {isError ? (
        <UsageErrorAlert isForbidden={isForbidden} />
      ) : (
        <UsageDashboard isLoading={isLoading} usage={usage} />
      )}
    </div>
  );
}
