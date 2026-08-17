"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { ChevronRightIcon, RotateCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  activityPoints,
  activitySeries,
  autonomyPoints,
  autonomySeries,
  getSyncStatusCopy,
  modelBreakdown,
  modelUsagePoints,
  modelUsageSeries,
  prBreakdown,
  prTrendPoints,
  prTrendSeries,
  recentSessions,
  type SyncTierId,
  stats,
} from "../mock";
import { TeamComparisonGate } from "./team-comparison-gate";

const currency = (value: number) => `$${value.toLocaleString("en-US")}`;

const ChartCard = ({
  title,
  description,
  anchor,
  children,
}: {
  title: string;
  description?: string;
  anchor?: string;
  children: ReactNode;
}) => (
  <Card data-tour={anchor}>
    <CardHeader>
      <CardTitle className="text-base">{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
    <CardContent>
      <div className="h-64">{children}</div>
    </CardContent>
  </Card>
);

const RecentSessionsCard = () => (
  <Card data-tour="sessions">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <RotateCwIcon className="size-4" />
        Latest sessions
      </CardTitle>
      <CardDescription>
        The {recentSessions.length} most recent runs on this device
      </CardDescription>
      {/* Decorative-only in this single-screen prototype, same as the
          sidebar's other inert nav entries (Inbox, Agents, Skills, …) — there
          is no sessions list route to link to here. Naming it truthfully
          still beats claiming the table below is the whole set (#4285 T8). */}
      <CardAction>
        <Button variant="link">
          View all
          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Repo</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recentSessions.map((session) => (
            <TableRow key={session.id}>
              <TableCell className="font-medium">{session.name}</TableCell>
              <TableCell>
                <ToneBadge
                  label={session.statusLabel}
                  pulse={session.pulse}
                  tone={session.statusTone}
                />
              </TableCell>
              {/* Plain foreground, not text-primary: the repo is a data value,
                  and an accent-coloured string in a row reads as a link. */}
              <TableCell>{session.repo}</TableCell>
              <TableCell className="text-muted-foreground">
                {session.model}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {session.cost}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {session.when}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
);

export const LocalDashboard = ({
  account,
  syncTier,
  teamHighlight,
  onCreateAccount,
}: {
  account: boolean;
  syncTier: SyncTierId | null;
  teamHighlight: boolean;
  onCreateAccount: () => void;
}) => (
  <div className="mx-auto flex max-w-[1200px] flex-col gap-4 p-5">
    <div>
      <h1 className="font-semibold text-2xl tracking-tight">
        Welcome to ClosedLoop
      </h1>
      {/* Reconciles with the header pill above the workspace: both read the
          same syncTier state, so the claim here can't go stale once the user
          actually picks a sync tier (#4285 T9). */}
      <p className="text-muted-foreground text-sm">
        {getSyncStatusCopy(syncTier).dashboardSubtitle}
      </p>
    </div>

    {/* headline stats */}
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
      data-tour="stats"
    >
      {stats.map((stat) => (
        <MetricCard
          delta={stat.delta}
          deltaLabel="vs. prior 90 days"
          // Activity headline counts — a rise is the product working (#4148).
          deltaPolarity={MetricPolarity.HigherIsBetter}
          detail={stat.detail}
          info={stat.info}
          key={stat.key}
          label={stat.label}
          value={stat.value}
        />
      ))}
    </div>

    <ChartCard
      anchor="activity"
      description="Each agent run and human input on this machine, last 90 days"
      title="When the work happens"
    >
      <TimeSeriesAreaChart
        points={[...activityPoints]}
        series={[...activitySeries]}
      />
    </ChartCard>

    <RecentSessionsCard />

    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard
        anchor="models"
        description="Model spend over time"
        title="Model spend"
      >
        <TimeSeriesAreaChart
          points={[...modelUsagePoints]}
          series={[...modelUsageSeries]}
          valueFormatter={currency}
        />
      </ChartCard>
      <ChartCard description="Total spend by model" title="Spend by model">
        <CategoryBarChart
          data={[...modelBreakdown]}
          horizontal
          showValueLabels
          valueFormatter={currency}
        />
      </ChartCard>
    </div>

    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard
        anchor="prs"
        description="PRs merged over time"
        title="Shipping velocity"
      >
        <TimeSeriesAreaChart
          points={[...prTrendPoints]}
          series={[...prTrendSeries]}
        />
      </ChartCard>
      <ChartCard description="Merged PRs by repository" title="PRs by repo">
        <CategoryBarChart data={[...prBreakdown]} horizontal showValueLabels />
      </ChartCard>
    </div>

    <ChartCard
      anchor="autonomy"
      description="How hands-off your sessions are getting (0 = manual, 100 = agentic)"
      title="Autonomy over time"
    >
      <TimeSeriesAreaChart
        points={[...autonomyPoints]}
        series={[...autonomySeries]}
      />
    </ChartCard>

    {/* the climax: the one chart you can't see without an account */}
    <div data-tour="team">
      <TeamComparisonGate
        account={account}
        highlight={teamHighlight}
        onCreateAccount={onCreateAccount}
      />
    </div>
  </div>
);
