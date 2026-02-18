"use client";

import type { LoopUsageByCommand } from "@repo/api/src/types/loop";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { useMemo, useState } from "react";
import { type LoopUsageFilters, useLoopUsage } from "@/hooks/queries/use-loops";

type DateRange = "7d" | "30d" | "90d" | "all";

function getStartDateForRange(range: DateRange): string | undefined {
  if (range === "all") {
    return undefined;
  }
  const daysMap: Record<Exclude<DateRange, "all">, number> = {
    "7d": 7,
    "30d": 30,
    "90d": 90,
  };
  const days = daysMap[range];
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toLocaleString();
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatCommand(command: string): string {
  return command
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

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

function SummaryCard({
  title,
  value,
  description,
}: {
  title: string;
  value: string;
  description?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="font-bold text-2xl">{value}</div>
        {description ? (
          <p className="mt-1 text-muted-foreground text-xs">{description}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CommandBreakdownTable({ data }: { data: LoopUsageByCommand[] }) {
  const sorted = useMemo(
    () => [...data].sort((a, b) => b.loopCount - a.loopCount),
    [data]
  );

  if (sorted.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No loop data for the selected period.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Command</TableHead>
          <TableHead className="text-right">Loops</TableHead>
          <TableHead className="text-right">Input Tokens</TableHead>
          <TableHead className="text-right">Output Tokens</TableHead>
          <TableHead className="text-right">Est. Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row) => (
          <TableRow key={row.command}>
            <TableCell className="font-medium">
              {formatCommand(row.command)}
            </TableCell>
            <TableCell className="text-right">
              {row.loopCount.toLocaleString()}
            </TableCell>
            <TableCell className="text-right">
              {formatTokens(row.tokensInput)}
            </TableCell>
            <TableCell className="text-right">
              {formatTokens(row.tokensOutput)}
            </TableCell>
            <TableCell className="text-right">
              {formatCost(row.estimatedCost)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function LoopUsagePage() {
  const [dateRange, setDateRange] = useState<DateRange>("30d");

  const filters: LoopUsageFilters = useMemo(
    () => ({
      startDate: getStartDateForRange(dateRange),
    }),
    [dateRange]
  );

  const { data: usage, isLoading } = useLoopUsage(filters);

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Usage Dashboard
          </h1>
          <p className="text-muted-foreground">
            Token consumption and estimated costs for AI loops.
          </p>
        </div>
        <Select
          onValueChange={(v) => setDateRange(v as DateRange)}
          value={dateRange}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(DATE_RANGE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          <>
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
            <SummaryCardSkeleton />
          </>
        ) : (
          <>
            <SummaryCard
              title="Total Loops"
              value={(usage?.totalLoops ?? 0).toLocaleString()}
            />
            <SummaryCard
              description={`${(usage?.totalTokensInput ?? 0).toLocaleString()} tokens`}
              title="Input Tokens"
              value={formatTokens(usage?.totalTokensInput ?? 0)}
            />
            <SummaryCard
              description={`${(usage?.totalTokensOutput ?? 0).toLocaleString()} tokens`}
              title="Output Tokens"
              value={formatTokens(usage?.totalTokensOutput ?? 0)}
            />
            <SummaryCard
              title="Estimated Cost"
              value={formatCost(usage?.totalEstimatedCost ?? 0)}
            />
          </>
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
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <CommandBreakdownTable data={usage?.byCommand ?? []} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
